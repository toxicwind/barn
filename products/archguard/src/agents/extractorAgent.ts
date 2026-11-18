import { getGraphCatalog } from '../engine/graphManager.js';
import { createProposalNode } from '../engine/graphAuditor.js';
import { extractProposalFromRawText } from '../llm/client.js';
import { LLMOptions, ExtractedProposal, AgentTrace } from '../types/index.js';

export interface ExtractorResult {
  proposalId: string;
  extracted: ExtractedProposal;
  trace: AgentTrace;
}

/**
 * Agent 1: ProposalExtractorAgent
 * 1. Reads current Graph Catalog from FalkorDB.
 * 2. Uses LLM (with deterministic fallback) to parse raw diff/spec/migration text into structured parameters.
 * 3. Writes the :Proposal {status: 'PARSED'} node and [:TARGETS_FIELD] edge directly into FalkorDB.
 * 4. Returns ONLY proposalId and extraction metadata (no giant prompt chaining).
 */
export async function runExtractorAgent(
  rawInput: string,
  suggestedTitle?: string,
  options?: LLMOptions,
  tenantGraphName?: string
): Promise<ExtractorResult> {
  const startTime = Date.now();
  const cypherQueries: string[] = [];

  // Step 1: Read Catalog from FalkorDB
  cypherQueries.push('MATCH (f:SchemaField), (e:Endpoint), (s:Service), (a:ADR) ...');
  const catalog = await getGraphCatalog(tenantGraphName);

  // Step 2: Extract structured parameters using grounded catalog
  const extracted = await extractProposalFromRawText(rawInput, catalog, options);
  if (suggestedTitle && suggestedTitle.trim().length > 0) {
    const suggestsInt64 = suggestedTitle.toLowerCase().includes('int64');
    const isCompliant = extracted.proposedValue === 'UUIDv4' || extracted.proposedValue === 'string';
    if (!(suggestsInt64 && isCompliant)) {
      extracted.title = suggestedTitle;
    }
  }

  // Derive proposal ID (e.g., from title if PR number exists, else timestamp)
  const prMatch = extracted.title.match(/PR\s*#?([0-9]+)/i);
  const proposalId = prMatch ? `PR-${prMatch[1]}` : `PR-CUSTOM-${Date.now().toString().slice(-4)}`;

  // Step 3: Write :Proposal node into FalkorDB shared graph
  cypherQueries.push(`MERGE (p:Proposal {id: '${proposalId}'}) ... CREATE (p)-[:TARGETS_FIELD]->(target)`);
  await createProposalNode(
    {
      proposalId,
      title: extracted.title,
      rawInput,
      author: extracted.author,
      targetType: extracted.targetType,
      targetName: extracted.targetName,
      changedProperty: extracted.changedProperty,
      proposedValue: extracted.proposedValue,
    },
    tenantGraphName
  );

  const durationMs = Date.now() - startTime;

  const trace: AgentTrace = {
    agent: 'ExtractorAgent',
    durationMs,
    cypherQueries,
    stateTransition: { from: 'RAW_INPUT', to: 'PARSED' },
    summary: `Extracted proposal '${extracted.title}' targeting ${extracted.targetType} '${extracted.targetName}' (${extracted.changedProperty}='${extracted.proposedValue}') and persisted to FalkorDB.`,
    provider: extracted.usedProvider,
  };

  return {
    proposalId,
    extracted,
    trace,
  };
}
