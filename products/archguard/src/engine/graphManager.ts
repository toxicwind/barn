import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { getGraph } from '../db/falkor.js';
import {
  GraphCatalog,
  GraphTopology,
  TopologyNode,
  TopologyLink,
  ADRFrontmatter,
  ArchitecturalEpisodeNode,
} from '../types/index.js';

/**
 * Retrieves the current catalog of valid graph entities from FalkorDB
 * to ground the Extractor Agent and avoid hallucinations.
 */
export async function getGraphCatalog(tenantGraphName?: string): Promise<GraphCatalog> {
  const graph = await getGraph(tenantGraphName);

  const [fieldsRes, endpointsRes, servicesRes, adrsRes] = await Promise.all([
    graph.query(`MATCH (f:SchemaField) RETURN f.name as name, f.data_type as data_type, f.execution_mode as execution_mode`),
    graph.query(`MATCH (e:Endpoint) RETURN e.path as path, e.method as method, e.execution_mode as execution_mode, e.contract_policy as contract_policy`),
    graph.query(`MATCH (s:Service) RETURN s.name as name, s.tier as tier`),
    graph.query(`MATCH (a:ADR) RETURN a.code as code, a.title as title, a.target_property as target_property, a.expected_value as expected_value, a.governs_target as governs_target`),
  ]);

  return {
    fields: (fieldsRes.data || []) as any[],
    endpoints: (endpointsRes.data || []) as any[],
    services: (servicesRes.data || []) as any[],
    adrs: (adrsRes.data || []) as any[],
  };
}

/**
 * Returns full FalkorDB graph topology (nodes, links, counts)
 * formatted for frontend graph visualizers.
 */
export async function getFullGraphTopology(tenantGraphName?: string): Promise<GraphTopology> {
  const graph = await getGraph(tenantGraphName);

  const nodesQuery = `MATCH (n) RETURN id(n) as id, labels(n) as labels, properties(n) as props`;
  const linksQuery = `MATCH (a)-[r]->(b) RETURN id(a) as source, id(b) as target, type(r) as type, properties(r) as props`;

  const [nodesRes, linksRes] = await Promise.all([
    graph.query(nodesQuery),
    graph.query(linksQuery),
  ]);

  const rawNodes = (nodesRes.data || []) as any[];
  if (rawNodes.length === 0) {
    const { seedDatabase } = await import('../db/seed.js');
    await seedDatabase(tenantGraphName);
    return getFullGraphTopology(tenantGraphName);
  }
  const rawLinks = (linksRes.data || []) as any[];

  let teamsCount = 0;
  let servicesCount = 0;
  let endpointsCount = 0;
  let adrsCount = 0;
  let episodesCount = 0;

  const nodes: TopologyNode[] = rawNodes.map((rn) => {
    const labels = Array.isArray(rn.labels) ? rn.labels : ['Entity'];
    const mainLabel = labels[0] || 'Entity';
    const props = rn.props || {};

    if (mainLabel === 'Team') teamsCount++;
    else if (mainLabel === 'Service') servicesCount++;
    else if (mainLabel === 'Endpoint') endpointsCount++;
    else if (mainLabel === 'ADR') adrsCount++;
    else if (mainLabel === 'ArchitecturalEpisode') episodesCount++;

    const displayName =
      props.name || props.title || props.code || props.path || props.handle || props.id || `Node ${rn.id}`;

    return {
      id: rn.id,
      label: mainLabel,
      name: displayName,
      properties: props,
    };
  });

  const links: TopologyLink[] = rawLinks.map((rl) => ({
    source: rl.source,
    target: rl.target,
    type: rl.type,
    properties: rl.props || {},
  }));

  return {
    nodes,
    links,
    stats: {
      totalNodes: nodes.length,
      totalEdges: links.length,
      teamsCount,
      servicesCount,
      endpointsCount,
      adrsCount,
      episodesCount,
    },
  };
}

/**
 * Ingests a new Markdown ADR file: writes it to /data/adrs/ and creates :ADR node in FalkorDB.
 */
export async function ingestNewMarkdownAdr(
  markdownContent: string,
  filename: string,
  tenantGraphName?: string
): Promise<{ adrCode: string; status: string }> {
  const { data, content } = matter(markdownContent);
  const frontmatter = data as ADRFrontmatter;

  if (!frontmatter.code || !frontmatter.title || !frontmatter.target_property || !frontmatter.expected_value) {
    throw new Error('Invalid ADR: frontmatter must include code, title, target_property, and expected_value.');
  }

  // Ensure /data/adrs/ directory exists and write file
  const adrsDir = path.resolve(process.cwd(), 'data', 'adrs');
  if (!fs.existsSync(adrsDir)) {
    fs.mkdirSync(adrsDir, { recursive: true });
  }

  const safeFilename = filename.endsWith('.md') ? filename : `${filename}.md`;
  const filePath = path.join(adrsDir, safeFilename);
  fs.writeFileSync(filePath, markdownContent, 'utf-8');

  // Insert/Merge in FalkorDB
  const graph = await getGraph(tenantGraphName);
  const now = new Date().toISOString();

  await graph.query(
    `MERGE (a:ADR {code: $code})
     ON CREATE SET 
       a.id = $id,
       a.title = $title,
       a.status = $status,
       a.rule_type = $rule_type,
       a.target_property = $target_property,
       a.expected_value = $expected_value,
       a.governs_target = $governs_target,
       a.author_handle = $author_handle,
       a.content = $content,
       a.created_at = $createdAt
     ON MATCH SET
       a.title = $title,
       a.status = $status,
       a.rule_type = $rule_type,
       a.target_property = $target_property,
       a.expected_value = $expected_value,
       a.governs_target = $governs_target,
       a.author_handle = $author_handle,
       a.content = $content,
       a.updated_at = $createdAt`,
    {
      params: {
        id: frontmatter.id || frontmatter.code,
        code: frontmatter.code,
        title: frontmatter.title,
        status: frontmatter.status || 'ACCEPTED',
        rule_type: frontmatter.rule_type || 'SCHEMA_FIELD_CONSTRAINT',
        target_property: frontmatter.target_property,
        expected_value: frontmatter.expected_value,
        governs_target: frontmatter.governs_target,
        author_handle: frontmatter.author_handle || 'architecture_lead',
        content: content.trim(),
        createdAt: now,
      },
    }
  );

  // Link to author if person exists
  if (frontmatter.author_handle) {
    await graph.query(
      `MATCH (p:Person {handle: $handle}), (a:ADR {code: $code})
       MERGE (p)-[:AUTHORED]->(a)`,
      { params: { handle: frontmatter.author_handle, code: frontmatter.code } }
    );
  }

  // Link [:GOVERNS] to target SchemaField or Endpoint
  await graph.query(
    `MATCH (a:ADR {code: $code}), (target)
     WHERE (target:SchemaField AND target.name = $targetName)
        OR (target:Endpoint AND target.path = $targetName)
     MERGE (a)-[:GOVERNS]->(target)`,
    { params: { code: frontmatter.code, targetName: frontmatter.governs_target } }
  );

  return {
    adrCode: frontmatter.code,
    status: 'INGESTED',
  };
}

/**
 * Records a new Architectural Episode (Episodic Memory) into FalkorDB,
 * linking it to the relevant ADR via [:APPLIES_TO].
 */
export async function recordNewArchitecturalEpisode(
  input: ArchitecturalEpisodeNode,
  tenantGraphName?: string
): Promise<{ episodeId: string; status: string }> {
  const graph = await getGraph(tenantGraphName);
  const adrCode = input.adrCode || 'ADR-001';

  await graph.query(
    `MERGE (e:ArchitecturalEpisode {code: $code})
     ON CREATE SET
       e.id = $id,
       e.incident_id = $incident_id,
       e.title = $title,
       e.summary = $summary,
       e.workaround_pattern = $workaround_pattern,
       e.approved_by = $approved_by,
       e.resolution_date = $resolution_date,
       e.trade_offs = $trade_offs
     ON MATCH SET
       e.title = $title,
       e.summary = $summary,
       e.workaround_pattern = $workaround_pattern,
       e.approved_by = $approved_by,
       e.resolution_date = $resolution_date,
       e.trade_offs = $trade_offs`,
    {
      params: {
        id: input.id || input.code,
        code: input.code,
        incident_id: input.incident_id,
        title: input.title,
        summary: input.summary,
        workaround_pattern: input.workaround_pattern,
        approved_by: input.approved_by,
        resolution_date: input.resolution_date,
        trade_offs: input.trade_offs,
      },
    }
  );

  // Link [:APPLIES_TO]->(:ADR)
  await graph.query(
    `MATCH (e:ArchitecturalEpisode {code: $code}), (a:ADR {code: $adrCode})
     MERGE (e)-[:APPLIES_TO]->(a)`,
    { params: { code: input.code, adrCode } }
  );

  return {
    episodeId: input.code,
    status: 'RECORDED',
  };
}
