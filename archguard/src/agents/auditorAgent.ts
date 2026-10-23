import { getGraph } from '../db/falkor.js';
import {
  checkAdrViolations,
  traceDownstreamBlastRadius,
  persistAuditFindings,
} from '../engine/graphAuditor.js';
import {
  AdrViolationFinding,
  BlastRadiusFinding,
  AgentTrace,
} from '../types/index.js';

export interface AuditorResult {
  proposalId: string;
  violationsCount: number;
  blastRadiusCount: number;
  violations: AdrViolationFinding[];
  blastRadius: BlastRadiusFinding[];
  trace: AgentTrace;
}

/**
 * Agent 2: GraphAuditorAgent
 * STRICT STATE RULE: Takes ONLY proposalId.
 * 1. Reads :Proposal state from FalkorDB.
 * 2. Runs deterministic multi-hop Cypher queries to check ADR violations and blast radius.
 * 3. Persists [:VIOLATES_ADR] and [:BREAKS_CONSUMER] edges directly into FalkorDB.
 * 4. Updates :Proposal {status: 'CHECKED'} in FalkorDB.
 */
export async function runAuditorAgent(
  proposalId: string,
  tenantGraphName?: string
): Promise<AuditorResult> {
  const startTime = Date.now();
  const cypherQueries: string[] = [];
  const graph = await getGraph(tenantGraphName);

  // Step 1: Verify proposal exists in FalkorDB
  cypherQueries.push(`MATCH (p:Proposal {id: '${proposalId}'}) RETURN p`);
  const propCheck = await graph.query(
    `MATCH (p:Proposal {id: $proposalId}) RETURN p.id as id, p.status as status`,
    { params: { proposalId } }
  );

  if (!propCheck.data || propCheck.data.length === 0) {
    throw new Error(`AuditorAgent Error: Proposal '${proposalId}' not found in FalkorDB graph state.`);
  }

  // Step 2: Deterministic ADR Violations Traversal
  cypherQueries.push(
    `MATCH (p:Proposal {id: '${proposalId}'})-[t:TARGETS_FIELD]->(target)<-[:GOVERNS]-(adr:ADR) WHERE adr.target_property = t.changed_property AND adr.expected_value <> t.proposed_value ...`
  );
  const violations = await checkAdrViolations(proposalId, tenantGraphName);

  // Step 3: Deterministic Downstream Blast Radius Traversal
  // Blast radius only impacts downstream consumers if an architectural policy is violated!
  let blastRadius: BlastRadiusFinding[] = [];
  if (violations.length > 0) {
    cypherQueries.push(
      `MATCH (p:Proposal {id: '${proposalId}'})-[:TARGETS_FIELD]->(target)<-[:USES_FIELD*0..1]-(ep:Endpoint)<-[:CONSUMES]-(consumer:Service) ...`
    );
    blastRadius = await traceDownstreamBlastRadius(proposalId, tenantGraphName);
  }

  // Step 4: Persist Audit findings directly into FalkorDB shared graph
  cypherQueries.push(
    `MATCH (p:Proposal {id: '${proposalId}'}) SET p.status = '${violations.length === 0 ? 'RESOLVED' : 'CHECKED'}' ...`
  );
  await persistAuditFindings(proposalId, violations, blastRadius, tenantGraphName);

  const durationMs = Date.now() - startTime;

  const trace: AgentTrace = {
    agent: 'AuditorAgent',
    durationMs,
    cypherQueries,
    stateTransition: { from: 'PARSED', to: violations.length === 0 ? 'RESOLVED' : 'CHECKED' },
    summary:
      violations.length === 0
        ? `Graph traversal verified 0 ADR violations. Proposal complies with all architectural policies with 0 broken downstream consumers.`
        : `Graph traversal identified ${violations.length} ADR violation(s) and ${blastRadius.length} broken downstream microservice(s). Persisted findings to FalkorDB.`,
  };

  return {
    proposalId,
    violationsCount: violations.length,
    blastRadiusCount: blastRadius.length,
    violations,
    blastRadius,
    trace,
  };
}
