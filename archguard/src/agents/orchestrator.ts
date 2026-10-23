import { runExtractorAgent } from './extractorAgent.js';
import { runAuditorAgent } from './auditorAgent.js';
import { runAdvisorAgent } from './advisorAgent.js';
import { getFullGraphTopology } from '../engine/graphManager.js';
import {
  FullAuditPayload,
  LLMOptions,
  GraphPath,
  AgentTrace,
} from '../types/index.js';

export async function runFullAuditWorkflow(
  rawInput: string,
  title?: string,
  options?: LLMOptions,
  tenantGraphName?: string
): Promise<FullAuditPayload> {
  const agentTraces: AgentTrace[] = [];

  // =========================================================================
  // 1. EXTRACTOR AGENT (Takes raw input, reads catalog, writes :Proposal)
  // =========================================================================
  const extractorOutput = await runExtractorAgent(rawInput, title, options, tenantGraphName);
  agentTraces.push(extractorOutput.trace);

  const proposalId = extractorOutput.proposalId;

  // =========================================================================
  // 2. GRAPH AUDITOR AGENT (Takes ONLY proposalId, traverses & writes findings)
  // =========================================================================
  const auditorOutput = await runAuditorAgent(proposalId, tenantGraphName);
  agentTraces.push(auditorOutput.trace);

  // =========================================================================
  // 3. RESOLUTION ADVISOR AGENT (Takes ONLY proposalId, recalls memory & resolves)
  // =========================================================================
  const advisorOutput = await runAdvisorAgent(proposalId, options, tenantGraphName);
  agentTraces.push(advisorOutput.trace);

  // Compute Highlighted Path for UI visualizer
  const highlightedPath: GraphPath = {
    nodes: [],
    relationshipTypes: [],
  };

  if (auditorOutput.violations.length > 0) {
    const v = auditorOutput.violations[0];
    highlightedPath.nodes.push(...v.path.nodes);
    highlightedPath.relationshipTypes.push(...v.path.relationshipTypes);
  }

  for (const b of auditorOutput.blastRadius) {
    for (const n of b.path.nodes) {
      if (!highlightedPath.nodes.some((hn) => hn.nodeId === n.nodeId)) {
        highlightedPath.nodes.push(n);
      }
    }
  }

  // Fetch updated full graph topology (with the new proposal and edges)
  const graphTopology = await getFullGraphTopology(tenantGraphName);

  return {
    proposalId,
    status: 'RESOLVED',
    proposal: {
      id: proposalId,
      title: extractorOutput.extracted.title,
      rawInput,
      author: extractorOutput.extracted.author,
      targetType: extractorOutput.extracted.targetType,
      targetName: extractorOutput.extracted.targetName,
      changedProperty: extractorOutput.extracted.changedProperty,
      proposedValue: extractorOutput.extracted.proposedValue,
    },
    agentTraces,
    violations: auditorOutput.violations,
    blastRadius: auditorOutput.blastRadius,
    episodicMemory: advisorOutput.episodicMemory,
    resolution: advisorOutput.resolution,
    highlightedPath,
    graphTopology,
  };
}
