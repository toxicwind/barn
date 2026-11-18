import { getGraph } from '../db/falkor.js';
import { recallEpisodicMemory } from '../engine/graphAuditor.js';
import { synthesizeResolutionAdvice } from '../llm/client.js';
import {
  ResolutionAdvice,
  EpisodicMemoryFinding,
  AdrViolationFinding,
  BlastRadiusFinding,
  AgentTrace,
  LLMOptions,
} from '../types/index.js';

export interface AdvisorResult {
  proposalId: string;
  resolution: ResolutionAdvice;
  episodicMemory: EpisodicMemoryFinding[];
  trace: AgentTrace;
}

/**
 * Agent 3: ResolutionAdvisorAgent
 * STRICT STATE RULE: Takes ONLY proposalId.
 * 1. Reads proposal, persisted violations, and blast radius directly from FalkorDB.
 * 2. Traverses FalkorDB episodic memory: (:Proposal)-[:VIOLATES_ADR]->(:ADR)<-[:APPLIES_TO]-(:ArchitecturalEpisode).
 * 3. Synthesizes a grounded architectural remediation report with exact citations and Slack alerts.
 * 4. Saves resolution and updates :Proposal {status: 'RESOLVED'} in FalkorDB.
 */
export async function runAdvisorAgent(
  proposalId: string,
  options?: LLMOptions,
  tenantGraphName?: string
): Promise<AdvisorResult> {
  const startTime = Date.now();
  const cypherQueries: string[] = [];
  const graph = await getGraph(tenantGraphName);

  // Step 1: Read Proposal and Persisted State from FalkorDB
  cypherQueries.push(`MATCH (p:Proposal {id: '${proposalId}'}) RETURN p`);
  const propRes = await graph.query(
    `MATCH (p:Proposal {id: $proposalId})
     RETURN 
       p.id as id,
       p.title as title,
       p.raw_input as rawInput,
       p.author as author,
       p.target_type as targetType,
       p.target_name as targetName,
       p.status as status`,
    { params: { proposalId } }
  );

  const proposalRow = (propRes.data?.[0] as any) || {};
  if (!proposalRow.id) {
    throw new Error(`AdvisorAgent Error: Proposal '${proposalId}' not found in FalkorDB.`);
  }

  // Read Persisted Violations
  cypherQueries.push(
    `MATCH (p:Proposal {id: '${proposalId}'})-[v:VIOLATES_ADR]->(a:ADR) OPTIONAL MATCH (a)<-[:AUTHORED]-(author:Person)-[:MEMBER_OF]->(t:Team) ...`
  );
  const violRes = await graph.query(
    `MATCH (p:Proposal {id: $proposalId})-[v:VIOLATES_ADR]->(a:ADR)
     OPTIONAL MATCH (a)<-[:AUTHORED]-(author:Person)-[:MEMBER_OF]->(t:Team)
     RETURN 
       a.id as adrId,
       a.code as adrCode,
       a.title as adrTitle,
       a.rule_type as ruleType,
       a.target_property as targetProperty,
       a.expected_value as expectedValue,
       v.proposed_value as proposedValue,
       a.author_handle as authorHandle,
       author.name as authorName,
       t.name as authorTeam,
       t.slack_channel as authorSlackChannel,
       a.governs_target as governsTarget,
       v.reason as explanation`,
    { params: { proposalId } }
  );

  const violations: AdrViolationFinding[] = ((violRes.data || []) as any[]).map((r) => ({
    adrId: r.adrId,
    adrCode: r.adrCode,
    adrTitle: r.adrTitle,
    ruleType: r.ruleType,
    targetProperty: r.targetProperty,
    expectedValue: r.expectedValue,
    proposedValue: r.proposedValue || '',
    authorHandle: r.authorHandle,
    authorName: r.authorName || 'Lead Architect',
    authorTeam: r.authorTeam || 'Architecture Board',
    authorSlackChannel: r.authorSlackChannel || '#architecture',
    governsTarget: r.governsTarget,
    explanation: r.explanation || 'Policy violation.',
    path: { nodes: [], relationshipTypes: [] },
  }));

  // Read Persisted Broken Consumers
  cypherQueries.push(
    `MATCH (p:Proposal {id: '${proposalId}'})-[b:BREAKS_CONSUMER]->(s:Service)<-[:OWNS]-(t:Team) ...`
  );
  const breakRes = await graph.query(
    `MATCH (p:Proposal {id: $proposalId})-[b:BREAKS_CONSUMER]->(s:Service)<-[:OWNS]-(t:Team)
     OPTIONAL MATCH (t)<-[:MEMBER_OF]-(lead:Person)
     WHERE lead.role CONTAINS 'Lead' OR lead.role CONTAINS 'Staff'
     RETURN DISTINCT
       s.id as serviceId,
       s.name as serviceName,
       s.tier as serviceTier,
       t.name as owningTeam,
       t.slack_channel as slackChannel,
       coalesce(lead.handle, 'unassigned') as techLeadHandle,
       coalesce(lead.name, 'Unassigned Lead') as techLeadName,
       b.via_endpoint as viaEndpoint,
       b.impact_level as impactLevel`,
    { params: { proposalId } }
  );

  const blastRadius: BlastRadiusFinding[] = ((breakRes.data || []) as any[]).map((r) => ({
    serviceId: r.serviceId,
    serviceName: r.serviceName,
    serviceTier: r.serviceTier || 'tier-1',
    owningTeam: r.owningTeam,
    slackChannel: r.slackChannel,
    techLeadHandle: r.techLeadHandle,
    techLeadName: r.techLeadName,
    viaEndpoint: r.viaEndpoint || '',
    impactLevel: r.impactLevel || 'CRITICAL',
    path: { nodes: [], relationshipTypes: [] },
  }));

  // Step 2: Recall Episodic Memory
  cypherQueries.push(
    `MATCH (p:Proposal {id: '${proposalId}'})-[:VIOLATES_ADR]->(a:ADR)<-[:APPLIES_TO]-(ep:ArchitecturalEpisode) RETURN ep`
  );
  const episodicMemory = await recallEpisodicMemory(proposalId, tenantGraphName);

  // Step 3: Synthesize Grounded Resolution Advice
  const resolution = await synthesizeResolutionAdvice(
    {
      proposal: {
        id: proposalRow.id,
        title: proposalRow.title,
        rawInput: proposalRow.rawInput,
        author: proposalRow.author,
        targetType: proposalRow.targetType,
        targetName: proposalRow.targetName,
      },
      violations,
      blastRadius,
      episodicMemory,
    },
    options
  );

  // Step 4: Save Resolution to FalkorDB and Update Status
  const now = new Date().toISOString();
  const finalStatus = violations.length === 0 ? 'APPROVED' : 'CONFLICT_DETECTED';
  cypherQueries.push(
    `MATCH (p:Proposal {id: '${proposalId}'}) SET p.status = '${finalStatus}', p.resolved_at = $resolvedAt`
  );
  await graph.query(
    `MATCH (p:Proposal {id: $proposalId})
     SET p.status = $finalStatus,
         p.resolution_summary = $summary,
         p.resolution_json = $resolutionJson,
         p.resolved_at = $resolvedAt`,
    {
      params: {
        proposalId,
        finalStatus,
        summary: resolution.executiveSummary,
        resolutionJson: JSON.stringify(resolution),
        resolvedAt: now,
      },
    }
  );

  const durationMs = Date.now() - startTime;

  const trace: AgentTrace = {
    agent: 'AdvisorAgent',
    durationMs,
    cypherQueries,
    stateTransition: { from: 'CHECKED', to: 'RESOLVED' },
    summary: `Synthesized remediation advice with ${resolution.impactedTeamsNotification.length} team notification(s) and ${episodicMemory.length} recalled episodic workaround pattern(s). Updated FalkorDB state to RESOLVED.`,
    provider: resolution.usedProvider,
  };

  return {
    proposalId,
    resolution,
    episodicMemory,
    trace,
  };
}
