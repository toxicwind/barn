// index.ts — gem-dredge CLI: list sidebar chats (MaZiqc), then probe candidate
// conversation ids the backend may still serve (hNvQHb) even though they are
// absent from the sidebar. Auto-discovers live RPC ids, rate-limits probes,
// exports recovered chats to md+json.
//
// Usage:
//   bun run src/index.ts                # default: all built-in candidates
//   bun run src/index.ts c_... c_...    # explicit cids
//   bun run src/index.ts --export out/  # write recovered chats as md/json
import { GeminiSession } from './session';
import { listChats, readChat } from './chat';
import { GRPC } from './grpc';
import type { ChatInfo, ChatHistory } from './types';
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';

const CDP = process.env.GEM_CDP_URL ?? 'http://127.0.0.1:25154';
const EXPORT_DIR = '/home/toxic/tmp/gem-forensic/recovered';
const LOG = '/home/toxic/tmp/gem-forensic/dredge-sweep.log';
const PROBE_DELAY_MS = Number(process.env.GEM_PROBE_DELAY_MS ?? 1200); // rate limit

interface ProbeResult { cid: string; status: string; turns: number; at: string; }

function md(hist: ChatHistory): string {
  const parts = [`# ${hist.cid}`, ''];
  for (const t of [...hist.turns].reverse()) {
    parts.push(`## ${t.role === 'user' ? '🧑 User' : '🤖 Gemini'}${t.rid ? ` \`${t.rid}\`` : ''}`, '', t.text, '');
  }
  return parts.join('\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const explicit = process.argv.filter((a) => a.startsWith('c_'));
  const exportIdx = process.argv.indexOf('--export');
  const doExport = exportIdx >= 0 && process.argv[exportIdx + 1];
  const results: ProbeResult[] = [];

  console.log(`[dredge] connecting CDP ${CDP} ...`);
  const { session, browser } = await GeminiSession.connect(CDP);
  try {
    console.log('[dredge] listing sidebar chats (MaZiqc)...');
    const roster = await listChats(session, 40);
    console.log(`[dredge] sidebar roster: ${roster.length} chats`);
    const rosterIds = new Set(roster.map((c) => c.cid));
    for (const c of roster) {
      const d = new Date(c.timestamp * 1000).toISOString();
      console.log(`  ${d}  ${c.cid}  ${c.isPinned ? 'PIN' : '   '}  ${c.title.slice(0, 60)}`);
    }

    // candidates = explicit args OR capture-derived cids not on roster
    let candidates: string[] = explicit;
    if (!candidates.length) {
      // Maximal sweep: every collectable cid — capture-derived working_dir
      // refs, roster rows themselves, and anything else discovered. Roster
      // rows are included: a delete may hide rows from the list while the
      // backend still serves turns for them.
      const capture = [
        'c_cc72eef21a93ba87', 'c_40f99315a4c5ef73', 'c_1801025b6da7eeec',
        'c_4b9661ad747f9416', 'c_80c82c051150060d', 'c_f818e1b7e13cd43a',
        'c_efdf82fd5e3e1d85', 'c_3190421637699989219',
      ];
      const all = new Set([...capture, ...rosterIds]);
      candidates = [...all];
      console.log(`[dredge] maximal sweep: ${candidates.length} candidate cids (roster + capture refs)`);
    }

    appendFileSync(LOG, `\n=== sweep ${new Date().toISOString()} — ${candidates.length} candidates ===\n`);

    const alive: { info: ChatInfo | null; hist: ChatHistory | null }[] = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const cid = candidates[i];
      const at = new Date().toISOString();
      try {
        const hist = await readChat(session, cid, 50);
        if (hist && hist.turns.length) {
          alive.push({ info: null, hist });
          const last = hist.turns[0]?.text.slice(0, 60) ?? '';
          console.log(`  ✅ ALIVE ${cid} — ${hist.turns.length} turns | ${last}`);
          appendFileSync(LOG, `ALIVE ${cid} ${hist.turns.length}\n`);
          results.push({ cid, status: 'alive', turns: hist.turns.length, at });
        } else {
          console.log(`  ⛔ gone  ${cid} — no turns served`);
          appendFileSync(LOG, `GONE ${cid}\n`);
          results.push({ cid, status: 'gone', turns: 0, at });
        }
      } catch (e) {
        console.log(`  ❌ error ${cid} — ${(e as Error).message.slice(0, 100)}`);
        appendFileSync(LOG, `ERROR ${cid} ${(e as Error).message.slice(0, 160)}\n`);
        results.push({ cid, status: 'error', turns: 0, at });
      }
      if (i < candidates.length - 1) await sleep(PROBE_DELAY_MS); // rate limit
    }

    if (doExport && alive.length) {
      mkdirSync(doExport, { recursive: true });
      for (const a of alive) {
        if (!a.hist) continue;
        writeFileSync(`${doExport}/${a.hist.cid}.md`, md(a.hist));
        writeFileSync(`${doExport}/${a.hist.cid}.json`, JSON.stringify(a.hist, null, 2));
      }
      console.log(`[dredge] exported ${alive.length} chats to ${doExport}/`);
    }

    console.log(`[dredge] done. alive=${alive.length} gone=${results.filter(r => r.status === 'gone').length} error=${results.filter(r => r.status === 'error').length}`);
  } finally {
    await session.close();
    await browser.close();
  }
}

await main();