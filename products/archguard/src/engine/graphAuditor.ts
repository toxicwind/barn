import { getGraph } from '../db/falkor.js';
import {
  ProposalInput,
  AdrViolationFinding,
  BlastRadiusFinding,
  EpisodicMemoryFinding,
  GraphPath,
} from '../types/index.js';

/**
 * 1. createProposalNode
 * Writes a :Proposal node and links it via [:TARGETS_FIELD {changed_property, proposed_value}]
 * to the target :SchemaField or :Endpoint.
 */
export async function createProposalNode(
  input: ProposalInput,
  tenantGraphName?: string
): Promise<{ proposalId: string; status: string; path: GraphPath }> {
  const graph = await getGraph(tenantGraphName);
  const now = new Date().toISOString();

  const cypher = `
    MATCH (target)
    WHERE (target:SchemaField AND target.name = $targetName)
       OR (target:Endpoint AND target.path = $targetName)
    MERGE (p:Proposal {id: $proposalId})
    ON CREATE SET 
      p.title = $title,
      p.raw_input = $rawInput,
      p.author = $author,
      p.target_type = $targetType,
      p.target_name = $targetName,
      p.status = 'PARSED',
      p.created_at = $createdAt
    ON MATCH SET
      p.title = $title,
      p.raw_input = $rawInput,
      p.author = $author,
      p.target_type = $targetType,
      p.target_name = $targetName,
      p.status = 'PARSED'
    WITH p, target
    OPTIONAL MATCH (p)-[oldR:TARGETS_FIELD]->()
    DELETE oldR
    CREATE (p)-[r:TARGETS_FIELD {
      changed_property: $changedProperty,
      proposed_value: $proposedValue,
      created_at: $createdAt
    }]->(target)
    RETURN 
      p.id as proposalId, 
      p.title as title, 
      p.status as status, 
      id(p) as proposalNodeId, 
      id(target) as targetNodeId,
      labels(target) as targetLabels,
      coalesce(target.name, target.path) as targetDisplayName
  `;

  const res = await graph.query(cypher, {
    params: {
      proposalId: input.proposalId,
      title: input.title,
      rawInput: input.rawInput,
      author: input.author,
      targetType: input.targetType,
      targetName: input.targetName,
      changedProperty: input.changedProperty,
      proposedValue: input.proposedValue,
      createdAt: now,
    },
  });

  const row = (res.data?.[0] as any) || {};
  const targetLabel = Array.isArray(row.targetLabels) ? row.targetLabels[0] : input.targetType;

  return {
    proposalId: input.proposalId,
    status: row.status || 'PARSED',
    path: {
      nodes: [
        { nodeId: row.proposalNodeId ?? 0, label: 'Proposal', name: input.title },
        { nodeId: row.targetNodeId ?? 0, label: targetLabel, name: row.targetDisplayName || input.targetName },
      ],
      relationshipTypes: ['TARGETS_FIELD'],
    },
  };
}

/**
 * 2. checkAdrViolations
 * Runs a deterministic multi-hop Cypher traversal from:
 * (:Proposal)-[:TARGETS_FIELD]->(:SchemaField | :Endpoint)<-[:GOVERNS]-(:ADR)
 * where adr.target_property = changed_property AND adr.expected_value <> proposed_value.
 * Also fetches the ADR author (:Person) and owning (:Team).
 */
export async function checkAdrViolations(
  proposalId: string,
  tenantGraphName?: string
): Promise<AdrViolationFinding[]> {
  const graph = await getGraph(tenantGraphName);

  const cypher = `
    MATCH (p:Proposal {id: $proposalId})-[t:TARGETS_FIELD]->(target)<-[:GOVERNS]-(adr:ADR)
    WHERE adr.target_property = t.changed_property AND adr.expected_value <> t.proposed_value
    OPTIONAL MATCH (adr)<-[:AUTHORED]-(author:Person)-[:MEMBER_OF]->(authorTeam:Team)
    RETURN 
      adr.id as adrId,
      adr.code as adrCode,
      adr.title as adrTitle,
      adr.rule_type as ruleType,
      adr.target_property as targetProperty,
      adr.expected_value as expectedValue,
      t.proposed_value as proposedValue,
      adr.author_handle as authorHandle,
      author.name as authorName,
      authorTeam.name as authorTeam,
      authorTeam.slack_channel as authorSlackChannel,
      adr.governs_target as governsTarget,
      id(p) as proposalNodeId,
      id(target) as targetNodeId,
      id(adr) as adrNodeId,
      id(author) as authorNodeId,
      id(authorTeam) as teamNodeId,
      labels(target) as targetLabels,
      coalesce(target.name, target.path) as targetDisplayName
  `;

  const res = await graph.query(cypher, { params: { proposalId } });
  const rows = (res.data || []) as any[];

  return rows.map((r) => {
    const targetLabel = Array.isArray(r.targetLabels) ? r.targetLabels[0] : 'GovernedTarget';
    const explanation = `Proposed change modifies '${r.targetProperty}' to '${r.proposedValue}', which directly violates architectural policy [${r.adrCode}: ${r.adrTitle}] mandating '${r.expectedValue}'.`;

    return {
      adrId: r.adrId,
      adrCode: r.adrCode,
      adrTitle: r.adrTitle,
      ruleType: r.ruleType,
      targetProperty: r.targetProperty,
      expectedValue: r.expectedValue,
      proposedValue: r.proposedValue,
      authorHandle: r.authorHandle,
      authorName: r.authorName || 'Architectural Lead',
      authorTeam: r.authorTeam || 'Architecture Board',
      authorSlackChannel: r.authorSlackChannel || '#architecture',
      governsTarget: r.governsTarget,
      explanation,
      path: {
        nodes: [
          { nodeId: r.proposalNodeId ?? 0, label: 'Proposal', name: proposalId },
          { nodeId: r.targetNodeId ?? 0, label: targetLabel, name: r.targetDisplayName ?? r.governsTarget },
          { nodeId: r.adrNodeId ?? 0, label: 'ADR', name: r.adrCode },
          { nodeId: r.authorNodeId ?? 0, label: 'Person', name: r.authorName ?? r.authorHandle },
          { nodeId: r.teamNodeId ?? 0, label: 'Team', name: r.authorTeam ?? 'Owning Team' },
        ],
        relationshipTypes: ['TARGETS_FIELD', 'GOVERNS', 'AUTHORED', 'MEMBER_OF'],
      },
    };
  });
}

/**
 * 3. traceDownstreamBlastRadius
 * Traverses from modified SchemaField/Endpoint through exposed and consumed relationships:
 * (:Proposal)-[:TARGETS_FIELD]->(:SchemaField)<-[:USES_FIELD]-(:Endpoint)<-[:CONSUMES]-(consumer:Service)<-[:OWNS]-(consumerTeam:Team)
 * and directly if target is an Endpoint:
 * (:Proposal)-[:TARGETS_FIELD]->(:Endpoint)<-[:CONSUMES]-(consumer:Service)<-[:OWNS]-(consumerTeam:Team)
 * Returns downstream services that will break, their owning teams, Slack channels, and Tech Leads.
 */
export async function traceDownstreamBlastRadius(
  proposalId: string,
  tenantGraphName?: string
): Promise<BlastRadiusFinding[]> {
  const graph = await getGraph(tenantGraphName);

  // Cypher for SchemaField targets
  const cypherField = `
    MATCH (p:Proposal {id: $proposalId})-[:TARGETS_FIELD]->(field:SchemaField)<-[:USES_FIELD]-(ep:Endpoint)<-[:CONSUMES]-(consumer:Service)<-[:OWNS]-(consumerTeam:Team)
    OPTIONAL MATCH (consumerTeam)<-[:MEMBER_OF]-(lead:Person)
    WHERE lead.role CONTAINS 'Lead' OR lead.role CONTAINS 'Staff' OR lead.role CONTAINS 'Principal'
    RETURN DISTINCT
      consumer.id as serviceId,
      consumer.name as serviceName,
      consumer.tier as serviceTier,
      consumerTeam.name as owningTeam,
      consumerTeam.slack_channel as slackChannel,
      coalesce(lead.handle, 'unassigned') as techLeadHandle,
      coalesce(lead.name, 'Unassigned Lead') as techLeadName,
      ep.path as viaEndpoint,
      id(p) as proposalNodeId,
      id(field) as fieldNodeId,
      id(ep) as endpointNodeId,
      id(consumer) as serviceNodeId,
      id(consumerTeam) as teamNodeId
  `;

  // Cypher for Endpoint targets
  const cypherEndpoint = `
    MATCH (p:Proposal {id: $proposalId})-[:TARGETS_FIELD]->(ep:Endpoint)<-[:CONSUMES]-(consumer:Service)<-[:OWNS]-(consumerTeam:Team)
    OPTIONAL MATCH (consumerTeam)<-[:MEMBER_OF]-(lead:Person)
    WHERE lead.role CONTAINS 'Lead' OR lead.role CONTAINS 'Staff' OR lead.role CONTAINS 'Principal'
    RETURN DISTINCT
      consumer.id as serviceId,
      consumer.name as serviceName,
      consumer.tier as serviceTier,
      consumerTeam.name as owningTeam,
      consumerTeam.slack_channel as slackChannel,
      coalesce(lead.handle, 'unassigned') as techLeadHandle,
      coalesce(lead.name, 'Unassigned Lead') as techLeadName,
      ep.path as viaEndpoint,
      id(p) as proposalNodeId,
      id(ep) as fieldNodeId,
      id(ep) as endpointNodeId,
      id(consumer) as serviceNodeId,
      id(consumerTeam) as teamNodeId
  `;

  const [resField, resEndpoint] = await Promise.all([
    graph.query(cypherField, { params: { proposalId } }),
    graph.query(cypherEndpoint, { params: { proposalId } }),
  ]);

  const rawRows = [...(resField.data || []), ...(resEndpoint.data || [])] as any[];

  // Deduplicate by distinct serviceName (counting distinct services, not paths)
  const serviceMap = new Map<string, BlastRadiusFinding>();

  for (const r of rawRows) {
    const existing = serviceMap.get(r.serviceName);
    if (existing) {
      if (r.viaEndpoint && !existing.viaEndpoint.includes(r.viaEndpoint)) {
        existing.viaEndpoint = `${existing.viaEndpoint}, ${r.viaEndpoint}`;
      }
      continue;
    }

    serviceMap.set(r.serviceName, {
      serviceId: r.serviceId,
      serviceName: r.serviceName,
      serviceTier: r.serviceTier || 'tier-1',
      owningTeam: r.owningTeam,
      slackChannel: r.slackChannel,
      techLeadHandle: r.techLeadHandle,
      techLeadName: r.techLeadName,
      viaEndpoint: r.viaEndpoint,
      impactLevel: r.serviceTier === 'tier-1' ? 'CRITICAL' : 'HIGH',
      path: {
        nodes: [
          { nodeId: r.proposalNodeId ?? 0, label: 'Proposal', name: proposalId },
          { nodeId: r.endpointNodeId ?? 0, label: 'Endpoint', name: r.viaEndpoint },
          { nodeId: r.serviceNodeId ?? 0, label: 'Service', name: r.serviceName },
          { nodeId: r.teamNodeId ?? 0, label: 'Team', name: r.owningTeam },
        ],
        relationshipTypes: ['TARGETS_FIELD', 'CONSUMES', 'OWNS'],
      },
    });
  }

  return Array.from(serviceMap.values());
}

/**
 * 4. persistAuditFindings
 * Updates the :Proposal status to 'CHECKED' and writes:
 * [:VIOLATES_ADR {reason, rule_type, expected_value, proposed_value}] and
 * [:BREAKS_CONSUMER {via_endpoint, impact_level}] edges directly into FalkorDB
 * so Agent 3 can read the state directly from the graph.
 */
export async function persistAuditFindings(
  proposalId: string,
  violations: AdrViolationFinding[],
  blastRadius: BlastRadiusFinding[],
  tenantGraphName?: string
): Promise<{ status: string; violationsPersisted: number; breaksPersisted: number }> {
  const graph = await getGraph(tenantGraphName);
  const now = new Date().toISOString();

  // 1. Update Proposal status and remove stale audit finding edges
  const targetStatus = violations.length === 0 ? 'RESOLVED' : 'CHECKED';
  await graph.query(
    `MATCH (p:Proposal {id: $proposalId})
     SET p.status = $targetStatus,
         p.checked_at = $checkedAt
     WITH p
     OPTIONAL MATCH (p)-[oldV:VIOLATES_ADR]->()
     OPTIONAL MATCH (p)-[oldB:BREAKS_CONSUMER]->()
     DELETE oldV, oldB`,
    { params: { proposalId, checkedAt: now, targetStatus } }
  );

  // 2. Persist [:VIOLATES_ADR] edges
  let violationsPersisted = 0;
  for (const v of violations) {
    await graph.query(
      `MATCH (p:Proposal {id: $proposalId}), (a:ADR {code: $adrCode})
       MERGE (p)-[r:VIOLATES_ADR]->(a)
       SET r.reason = $reason,
           r.rule_type = $ruleType,
           r.expected_value = $expectedValue,
           r.proposed_value = $proposedValue,
           r.created_at = $createdAt`,
      {
        params: {
          proposalId,
          adrCode: v.adrCode,
          reason: v.explanation,
          ruleType: v.ruleType,
          expectedValue: v.expectedValue,
          proposedValue: v.proposedValue,
          createdAt: now,
        },
      }
    );
    violationsPersisted++;
  }

  // 3. Persist [:BREAKS_CONSUMER] edges
  let breaksPersisted = 0;
  for (const b of blastRadius) {
    await graph.query(
      `MATCH (p:Proposal {id: $proposalId}), (s:Service {name: $serviceName})
       MERGE (p)-[r:BREAKS_CONSUMER]->(s)
       SET r.via_endpoint = $viaEndpoint,
           r.impact_level = $impactLevel,
           r.created_at = $createdAt`,
      {
        params: {
          proposalId,
          serviceName: b.serviceName,
          viaEndpoint: b.viaEndpoint,
          impactLevel: b.impactLevel,
          createdAt: now,
        },
      }
    );
    breaksPersisted++;
  }

  return {
    status: 'CHECKED',
    violationsPersisted,
    breaksPersisted,
  };
}

/**
 * 5. recallEpisodicMemory
 * Traverses (:Proposal)-[:VIOLATES_ADR]->(:ADR)<-[:APPLIES_TO]-(:ArchitecturalEpisode)
 * to retrieve past architectural compromises and approved workarounds.
 */
export async function recallEpisodicMemory(
  proposalId: string,
  tenantGraphName?: string
): Promise<EpisodicMemoryFinding[]> {
  const graph = await getGraph(tenantGraphName);

  const cypher = `
    MATCH (p:Proposal {id: $proposalId})-[:VIOLATES_ADR]->(adr:ADR)<-[:APPLIES_TO]-(ep:ArchitecturalEpisode)
    RETURN 
      ep.id as episodeId,
      ep.code as code,
      ep.incident_id as incidentId,
      ep.title as title,
      ep.summary as summary,
      ep.workaround_pattern as workaroundPattern,
      ep.approved_by as approvedBy,
      ep.resolution_date as resolutionDate,
      ep.trade_offs as tradeOffs,
      adr.code as relatedAdrCode,
      id(p) as proposalNodeId,
      id(adr) as adrNodeId,
      id(ep) as episodeNodeId
  `;

  const res = await graph.query(cypher, { params: { proposalId } });
  const rows = (res.data || []) as any[];

  return rows.map((r) => ({
    episodeId: r.episodeId,
    incidentId: r.incidentId,
    title: r.title,
    summary: r.summary,
    workaroundPattern: r.workaroundPattern,
    approvedBy: r.approvedBy,
    resolutionDate: r.resolutionDate,
    tradeOffs: r.tradeOffs,
    relatedAdrCode: r.relatedAdrCode,
    path: {
      nodes: [
        { nodeId: r.proposalNodeId ?? 0, label: 'Proposal', name: proposalId },
        { nodeId: r.adrNodeId ?? 0, label: 'ADR', name: r.relatedAdrCode },
        { nodeId: r.episodeNodeId ?? 0, label: 'ArchitecturalEpisode', name: r.title },
      ],
      relationshipTypes: ['VIOLATES_ADR', 'APPLIES_TO'],
    },
  }));
}
