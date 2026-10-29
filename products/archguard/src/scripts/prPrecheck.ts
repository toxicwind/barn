/**
 * prPrecheck — deterministic pre-merge invariant check for the pr-review path.
 *
 * Reads a unified diff (file, stdin, or `git diff` in a repo), extracts
 * proposals that touch ESTATE-governed targets via EXPLICIT rules (no LLM,
 * no heuristics beyond the documented regexes), and runs them through the
 * deterministic graphAuditor (Cypher-only) against the `archguard_estate`
 * graph. Emits violations + blast radius + cited ADR codes with per-step
 * measured latencies.
 *
 * Integration point: pr-review skill, Step 1.6 (readiness gate extension) —
 * run this BEFORE the substance pass; a VIOLATION verdict is a blocker.
 *
 * Usage:
 *   npx tsx src/scripts/prPrecheck.ts --diff /path/to/change.diff
 *   npx tsx src/scripts/prPrecheck.ts --stdin < change.diff
 *   npx tsx src/scripts/prPrecheck.ts --git /home/toxic/estate/ranch origin/main HEAD
 *
 * Exit codes: 0 = clean (no governed targets touched, or touched-but-compliant),
 *             2 = one or more ADR violations (block the merge).
 *
 * Env: FALKORDB_HOST / FALKORDB_PORT / FALKORDB_GRAPH_NAME (default archguard_estate).
 * LLM keys are never consulted — the engine path used here is Cypher-only.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import {
  createProposalNode,
  checkAdrViolations,
  traceDownstreamBlastRadius,
  persistAuditFindings,
} from '../engine/graphAuditor.js';
import { closeFalkorClient } from '../db/falkor.js';

const GRAPH = process.env.FALKORDB_GRAPH_NAME || 'archguard_estate';

interface FileDiff {
  file: string;
  added: string[];
  removed: string[];
}

interface ExtractedProposal {
  rule: string;
  targetName: string;
  changedProperty: string;
  proposedValue: string;
  evidence: string[];
}

function parseDiff(diffText: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  for (const line of diffText.split('\n')) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m) {
      cur = { file: m[1], added: [], removed: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) cur.added.push(line.slice(1));
    else if (line.startsWith('-') && !line.startsWith('---')) cur.removed.push(line.slice(1));
  }
  return files;
}

const PORT_RE = /(25\d{3})/g;

/**
 * Explicit extraction rules. Each rule is a pure function of the diff text.
 * Documented here so a reviewer can audit exactly what the pre-check sees.
 */
function extractProposals(files: FileDiff[]): ExtractedProposal[] {
  const out: ExtractedProposal[] = [];

  for (const f of files) {
    const addedText = f.added.join('\n');
    const removedText = f.removed.join('\n');

    // Rule A — EST-001: hodos port pin. A daemon-config change that drops the
    // 25193 reference or replaces it with another port. Key-aware: the port is
    // read from the SAME config key that held 25193 in the removed lines, so
    // incidental context ports (e.g. the daemon's own listen port) are not
    // mistaken for the change.
    if (/pitchfork/i.test(f.file) && /25193/.test(removedText)) {
      const keyPort = (l: string): Array<[string, string]> => {
        const pairs: Array<[string, string]> = [];
        const re = /([A-Za-z_][\w.]*)\s*=\s*"[^"]*?(\b25\d{3}\b)[^"]*"/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(l)) !== null) pairs.push([m[1], m[2]]);
        return pairs;
      };
      const removedKeys = new Map<string, string>();
      for (const l of f.removed) for (const [k, p] of keyPort(l)) removedKeys.set(k, p);
      const addedKeys = new Map<string, string>();
      for (const l of f.added) for (const [k, p] of keyPort(l)) addedKeys.set(k, p);

      for (const [key, oldPort] of removedKeys) {
        if (oldPort !== '25193') continue;
        const newPort = addedKeys.get(key);
        if (newPort === undefined || newPort !== '25193') {
          out.push({
            rule: 'A (EST-001)',
            targetName: 'hodos-api-port',
            changedProperty: 'port',
            proposedValue: newPort ?? 'removed',
            evidence: [
              `${f.file}: ${key} referenced 127.0.0.1:25193, now ${newPort ? '127.0.0.1:' + newPort : 'absent'}`,
            ],
          });
        }
      }
      // Fallback: bare 25193 reference with no parseable key — any 25xxx port
      // in added lines that never appeared in removed lines.
      if (removedKeys.size === 0) {
        const removedPorts = new Set<string>();
        for (const l of f.removed) {
          let m: RegExpExecArray | null;
          PORT_RE.lastIndex = 0;
          while ((m = PORT_RE.exec(l)) !== null) removedPorts.add(m[1]);
        }
        const novel = new Set<string>();
        for (const l of f.added) {
          let m: RegExpExecArray | null;
          PORT_RE.lastIndex = 0;
          while ((m = PORT_RE.exec(l)) !== null) if (!removedPorts.has(m[1])) novel.add(m[1]);
        }
        if (novel.size > 0 || !/25193/.test(addedText)) {
          out.push({
            rule: 'A (EST-001)',
            targetName: 'hodos-api-port',
            changedProperty: 'port',
            proposedValue: novel.size > 0 ? [...novel].sort()[0] : 'removed',
            evidence: [`${f.file}: removed lines referenced 127.0.0.1:25193`],
          });
        }
      }
    }

    // Rule B — EST-002: Kilo Gateway naming invariant. Fires on an ACTUAL
    // rename, not on mere mentions: (a) a "Kilo Gateway" string is removed and
    // not restored in the same file (rename-away), or (b) kappa.ai naming is
    // introduced inside kappa-gateway source (the Oct-17 incident's blast
    // zone: packages/kappa-gateway/src/api/constants.ts). Documentation and
    // test fixtures that merely mention the forbidden strings do NOT trip it
    // (proven: this script's own comments contain "Kappa Gateway" and stay clean).
    const inKappaGatewaySrc = /kappa-gateway/i.test(f.file);
    const kappaIntroduced = /kappa[ -]?gateway/i.test(addedText) || /api\.kappa\.ai/i.test(addedText);
    const kiloRemoved = /kilo[ -]?gateway/i.test(removedText) && !/kilo[ -]?gateway/i.test(addedText);
    if ((inKappaGatewaySrc && kappaIntroduced) || (kiloRemoved && kappaIntroduced)) {
      const nameMatch = addedText.match(/kappa[ -]?gateway/i) || addedText.match(/api\.kappa\.ai/i);
      out.push({
        rule: 'B (EST-002)',
        targetName: 'kilo-gateway-display-name',
        changedProperty: 'display_name',
        proposedValue: nameMatch ? nameMatch[0] : 'renamed',
        evidence: [`${f.file}: ${kappaIntroduced ? 'introduced kappa.ai naming' : 'removed Kilo Gateway naming'}`],
      });
    }

    // Rule C — EST-003: oracle ledger as settle-claim truth source. A change
    // in oracle/settle/ledger files that swaps the claim source identifier.
    if (/oracle|settle|ledger/i.test(f.file)) {
      const srcRemoved = removedText.match(/settle_claim_source\s*=\s*"([^"]+)"/);
      const srcAdded = addedText.match(/settle_claim_source\s*=\s*"([^"]+)"/);
      if (srcRemoved && (!srcAdded || srcAdded[1] !== srcRemoved[1])) {
        out.push({
          rule: 'C (EST-003)',
          targetName: 'settle-claim-source',
          changedProperty: 'settle_claim_source',
          proposedValue: srcAdded ? srcAdded[1] : 'removed',
          evidence: [`${f.file}: settle_claim_source changed from "${srcRemoved[1]}"`],
        });
      }
    }

    // Rule D — EST-004: toxicwind forks canonical. A remote/push-target change
    // pointing at a non-toxicwind GitHub org.
    if (/\.gitmodules|gitconfig|remote/i.test(f.file)) {
      for (const l of f.added) {
        const u = l.match(/github\.com[/:]([^/\s"']+)\//);
        if (u && u[1].toLowerCase() !== 'toxicwind') {
          out.push({
            rule: 'D (EST-004)',
            targetName: 'upstream-remote-target',
            changedProperty: 'push_target',
            proposedValue: u[0],
            evidence: [`${f.file}: remote now points at ${u[0]}`],
          });
        }
      }
    }
  }
  return out;
}

interface PrecheckResult {
  proposals: number;
  violations: Array<{
    rule: string;
    adrCode: string;
    adrTitle: string;
    target: string;
    changedProperty: string;
    expectedValue: string;
    proposedValue: string;
    explanation: string;
    blastRadius: Array<{ service: string; via: string; impact: string }>;
    latenciesMs: Record<string, number>;
  }>;
  clean: boolean;
}

async function runPrecheck(diffText: string): Promise<PrecheckResult> {
  const files = parseDiff(diffText);
  const proposals = extractProposals(files);
  const result: PrecheckResult = { proposals: proposals.length, violations: [], clean: true };

  let i = 0;
  for (const p of proposals) {
    const lat: Record<string, number> = {};
    const proposalId = `precheck-${Date.now()}-${i++}`;
    const title = `${p.rule}: ${p.targetName} ${p.changedProperty} -> ${p.proposedValue}`;

    let t = process.hrtime.bigint();
    await createProposalNode(
      {
        proposalId,
        title,
        rawInput: p.evidence.join(' | '),
        author: 'pr-precheck',
        targetType: 'SchemaField',
        targetName: p.targetName,
        changedProperty: p.changedProperty,
        proposedValue: p.proposedValue,
      },
      GRAPH
    );
    lat.createProposalMs = Number(process.hrtime.bigint() - t) / 1e6;

    t = process.hrtime.bigint();
    const violations = await checkAdrViolations(proposalId, GRAPH);
    lat.checkViolationsMs = Number(process.hrtime.bigint() - t) / 1e6;

    t = process.hrtime.bigint();
    const blast = await traceDownstreamBlastRadius(proposalId, GRAPH);
    lat.blastRadiusMs = Number(process.hrtime.bigint() - t) / 1e6;

    t = process.hrtime.bigint();
    await persistAuditFindings(proposalId, violations, blast, GRAPH);
    lat.persistMs = Number(process.hrtime.bigint() - t) / 1e6;

    for (const v of violations) {
      result.clean = false;
      // Estate tier semantics: the fork's engine maps tier-1 -> CRITICAL,
      // everything else -> HIGH. On the estate, tier-0 outranks tier-1, so
      // remap for display (engine output untouched).
      const blastOut = blast.map((b) => ({
        service: b.serviceName,
        via: b.viaEndpoint,
        impact: b.serviceTier === 'tier-0' ? 'CRITICAL' : b.impactLevel,
      }));
      result.violations.push({
        rule: p.rule,
        adrCode: v.adrCode,
        adrTitle: v.adrTitle,
        target: p.targetName,
        changedProperty: v.targetProperty,
        expectedValue: v.expectedValue,
        proposedValue: v.proposedValue,
        explanation: v.explanation,
        blastRadius: blastOut,
        latenciesMs: lat,
      });
    }
  }
  return result;
}

function printHuman(result: PrecheckResult, files: FileDiff[]) {
  console.log(`\n[PRECHECK] files scanned: ${files.length}, proposals extracted: ${result.proposals}`);
  if (result.clean) {
    console.log('[PRECHECK] CLEAN — no ADR violations. No governed targets tripped.');
    return;
  }
  console.log(`[PRECHECK] VIOLATIONS: ${result.violations.length} — BLOCK THE MERGE`);
  for (const v of result.violations) {
    console.log(`\n  [${v.adrCode}] ${v.adrTitle}`);
    console.log(`    rule: ${v.rule} | target: ${v.target}`);
    console.log(`    ${v.explanation}`);
    console.log(`    blast radius: ${v.blastRadius.map((b) => `${b.service} (via ${b.via}, ${b.impact})`).join('; ') || 'none traced'}`);
    console.log(`    latencies ms: ${Object.entries(v.latenciesMs).map(([k, ms]) => `${k}=${ms.toFixed(2)}`).join(' ')}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  let diffText = '';
  if (args[0] === '--diff' && args[1]) {
    diffText = fs.readFileSync(args[1], 'utf-8');
  } else if (args[0] === '--stdin') {
    diffText = fs.readFileSync(0, 'utf-8');
  } else if (args[0] === '--git' && args[1] && args[2] && args[3]) {
    diffText = execSync(`git -C ${args[1]} diff ${args[2]}...${args[3]}`, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  } else {
    console.error('usage: prPrecheck.ts --diff <file> | --stdin | --git <repo> <base> <head>');
    process.exit(3);
  }

  const files = parseDiff(diffText);
  const t0 = process.hrtime.bigint();
  const result = await runPrecheck(diffText);
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
  printHuman(result, files);
  console.log(`[PRECHECK] total wall: ${totalMs.toFixed(2)} ms (graph: ${GRAPH})`);
  console.log(JSON.stringify(result, null, 1));
  await closeFalkorClient();
  process.exit(result.clean ? 0 : 2);
}

main().catch(async (e) => {
  console.error('precheck failed:', e);
  try { await closeFalkorClient(); } catch { /* noop */ }
  process.exit(1);
});
