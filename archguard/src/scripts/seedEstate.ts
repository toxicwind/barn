/**
 * ESTATE seed for ArchGuard — replaces the FinCore seed with the real estate.
 *
 * Graph: `archguard_estate` (separate from the FinCore `archguard_brain`).
 * Port/service facts verified live on awrawr-pc 2026-10-20 (ss -tlnp).
 * ADR nodes are Chris's standing rulings, modeled so the deterministic
 * graphAuditor traversal (Proposal-[TARGETS_FIELD]->target<-[GOVERNS]-ADR,
 * WHERE adr.target_property = t.changed_property AND
 *        adr.expected_value <> t.proposed_value)
 * trips on diffs that violate them. LLM-free: pure Cypher, like seed.ts.
 *
 * Provenance: barn/archguard in-tree import of toxicwind/archguard @ 9f925e6.
 * Run: npm run seed:estate  (or: FALKORDB_GRAPH_NAME=archguard_estate tsx src/scripts/seedEstate.ts)
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { getGraph, deleteGraph, closeFalkorClient } from '../db/falkor.js';

const GRAPH_NAME = process.env.FALKORDB_GRAPH_NAME || 'archguard_estate';

interface SeedSummary {
  adrsCount: number;
  teamsCount: number;
  personsCount: number;
  servicesCount: number;
  endpointsCount: number;
  schemaFieldsCount: number;
  episodesCount: number;
  relationshipsCount: number;
}

export async function seedEstateDatabase(tenantGraphName = GRAPH_NAME): Promise<SeedSummary> {
  console.log(`\n============================================================`);
  console.log(`[ESTATE-SEED] Seeding estate graph "${tenantGraphName}" in FalkorDB...`);
  console.log(`============================================================`);

  console.log(`[ESTATE-SEED] 1/7 Cleaning previous estate graph state...`);
  await deleteGraph(tenantGraphName);
  const graph = await getGraph(tenantGraphName);

  const execute = async (cypher: string, params?: Record<string, any>) => {
    return graph.query(cypher, params ? { params } : undefined);
  };

  // Step 2: Estate ADR nodes — Chris's standing rulings (exact texts)
  console.log(`[ESTATE-SEED] 2/7 Creating estate ADR nodes...`);
  const adrs = [
    {
      id: 'EST-001',
      code: 'EST-001',
      title: 'hodos stays on 127.0.0.1:25193',
      status: 'ACCEPTED',
      rule_type: 'PORT_PIN',
      target_property: 'port',
      expected_value: '25193',
      governs_target: 'hodos-api-port',
      author_handle: 'chris',
      content:
        'Standing ruling (Chris, 2026-10-19): 127.0.0.1:25193 = hodos, keep. The NIM/NVCF ' +
        'router gateway lives on port 25193. Model-guard, the bidder fleet, gatehouse and the ' +
        'oracle executor lanes all route through it. Any proposal re-pointing this port trips EST-001.',
    },
    {
      id: 'EST-002',
      code: 'EST-002',
      title: 'Kilo Gateway is a kilo.ai external — never rename it',
      status: 'ACCEPTED',
      rule_type: 'NAMING_INVARIANT',
      target_property: 'display_name',
      expected_value: 'Kilo Gateway',
      governs_target: 'kilo-gateway-display-name',
      author_handle: 'chris',
      content:
        'Standing ruling (Chris, 2026-10-19): the Oct 17 kilo→kappa fork rename overreached onto ' +
        'kilo.ai service surface ("Kappa Gateway", api.kappa.ai — a dead domain); reverted in ' +
        '7e57dd1f21 (306 files) + guard comment/commit 185ed01c7e in ' +
        'packages/kappa-gateway/src/api/constants.ts. Internal kappa identifiers stay; the ' +
        'external "Kilo Gateway" name never changes. Any proposal renaming it trips EST-002.',
    },
    {
      id: 'EST-003',
      code: 'EST-003',
      title: 'the oracle ledger is the truth-source for settle claims',
      status: 'ACCEPTED',
      rule_type: 'SETTLE_INVARIANT',
      target_property: 'settle_claim_source',
      expected_value: 'oracle-ledger',
      governs_target: 'settle-claim-source',
      author_handle: 'chris',
      content:
        'Standing ruling (Chris): settle claims on the oracle market are verified against the ' +
        'oracle ledger, never against a lane\'s local assertion. Never claim a settle without a ' +
        'ledger event. Any proposal changing the settle-claim source away from the ledger trips EST-003.',
    },
    {
      id: 'EST-004',
      code: 'EST-004',
      title: 'no PRs to upstreams — toxicwind forks are canonical',
      status: 'ACCEPTED',
      rule_type: 'REPO_INVARIANT',
      target_property: 'push_target',
      expected_value: 'toxicwind/*',
      governs_target: 'upstream-remote-target',
      author_handle: 'chris',
      content:
        'Standing ruling (Chris, 2026-09-20): never open PRs against original upstreams. Our ' +
        'toxicwind/* forks are canonical — push directly to their main. Any proposal redirecting ' +
        'a repo remote/push target to an upstream trips EST-004.',
    },
  ];

  for (const a of adrs) {
    await execute(
      `CREATE (a:ADR {
        id: $id, code: $code, title: $title, status: $status,
        rule_type: $rule_type, target_property: $target_property,
        expected_value: $expected_value, governs_target: $governs_target,
        author_handle: $author_handle, content: $content
      })`,
      a
    );
    console.log(`   + Created :ADR [${a.code}] "${a.title}" (Rule: ${a.rule_type})`);
  }

  // Step 3: Teams & persons
  console.log(`[ESTATE-SEED] 3/7 Seeding estate teams and persons...`);
  const teams = [
    { id: 'team-pack', name: 'estate-pack', slack_channel: '#fleet', domain: "Kite's crew — agent lanes on the estate" },
    { id: 'team-forge', name: 'Forge-lane', slack_channel: '#fleet', domain: 'migration smith: Tier-0 TS re-cutovers' },
  ];
  for (const t of teams) {
    await execute(`CREATE (t:Team {id: $id, name: $name, slack_channel: $slack_channel, domain: $domain})`, t);
  }
  const persons = [
    { id: 'p-chris', handle: 'chris', name: 'Chris', role: 'Tech Lead', email: 'chris@estate', team: 'estate-pack' },
    { id: 'p-forge', handle: 'forge', name: 'Forge', role: 'Staff Engineer', email: 'forge@estate', team: 'Forge-lane' },
  ];
  for (const p of persons) {
    await execute(
      `MATCH (t:Team {name: $team})
       CREATE (pp:Person {id: $id, handle: $handle, name: $name, role: $role, email: $email})-[:MEMBER_OF]->(t)`,
      p
    );
    await execute(
      `MATCH (pp:Person {handle: $handle}), (a:ADR {author_handle: $handle})
       CREATE (pp)-[:AUTHORED]->(a)`,
      { handle: p.handle }
    );
  }

  // Step 4: Services & endpoints (ports verified live 2026-10-20 via ss -tlnp)
  console.log(`[ESTATE-SEED] 4/7 Seeding estate services and endpoints...`);
  const services = [
    { id: 'svc-hodos', name: 'hodos', tier: 'tier-0', port: '25193', team: 'estate-pack', description: 'NIM/NVCF router gateway (flock), the model plane' },
    { id: 'svc-model-guard', name: 'model-guard', tier: 'tier-0', port: '25101', team: 'Forge-lane', description: 'Model guard proxy in front of hodos' },
    { id: 'svc-squawk-ws', name: 'squawk-ws', tier: 'tier-0', port: '25147', team: 'estate-pack', description: 'Fleet chat bus (WebSocket)' },
    { id: 'svc-awrawr-mcp', name: 'awrawr-mcp', tier: 'tier-0', port: '25198', team: 'estate-pack', description: 'Output-persistence MCP server' },
    { id: 'svc-cuttinggate', name: 'cuttinggate', tier: 'tier-0', port: '25200', team: 'estate-pack', description: 'Bidder executor route-1 gateway' },
    { id: 'svc-gatehouse', name: 'gatehouse', tier: 'tier-1', port: '25127', team: 'estate-pack', description: 'MCP proxy, ~50 servers' },
    { id: 'svc-keypool', name: 'keypool', tier: 'tier-1', port: '25109', team: 'estate-pack', description: 'Keypool sidecar' },
    { id: 'svc-herd', name: 'herd', tier: 'retired', port: '25100', team: 'estate-pack', description: 'Legacy router, dark API since de-herd 2026-10-13' },
    { id: 'svc-oracle-market', name: 'oracle-market', tier: 'tier-1', port: 'daemon', team: 'estate-pack', description: 'Oracle task market + tamper-evident ledger' },
    { id: 'svc-bidder-fleet', name: 'bidder-fleet', tier: 'tier-1', port: 'daemon', team: 'estate-pack', description: 'Six bidder agents bidding on oracle tasks' },
    { id: 'svc-kappa-code', name: 'kappa-code', tier: 'tier-1', port: 'daemon', team: 'estate-pack', description: 'kappa-code repo + CI (Kilo Gateway external client)' },
    { id: 'svc-executor', name: 'executor', tier: 'tier-1', port: 'daemon', team: 'estate-pack', description: 'Oracle task executor lane' },
    { id: 'svc-ranch-ci', name: 'ranch-ci', tier: 'tier-1', port: 'daemon', team: 'estate-pack', description: 'Ranch continuous integration' },
    { id: 'svc-archguard-api', name: 'archguard-api', tier: 'tier-1', port: '4000', team: 'Forge-lane', description: 'ArchGuard deterministic audit API (this service)' },
  ];
  for (const s of services) {
    await execute(
      `MATCH (t:Team {name: $team})
       CREATE (sv:Service {id: $id, name: $name, tier: $tier, port: $port, description: $description})<-[:OWNS]-(t)`,
      s
    );
  }

  const endpoints = [
    { id: 'ep-hodos-models', path: 'hodos:/v1/models', method: 'GET', service: 'hodos', field: 'hodos-api-port' },
    { id: 'ep-hodos-chat', path: 'hodos:/v1/chat/completions', method: 'POST', service: 'hodos', field: 'hodos-api-port' },
    { id: 'ep-oracle-settle', path: 'oracle-market:/ledger/settle', method: 'POST', service: 'oracle-market', field: 'settle-claim-source' },
    { id: 'ep-kappa-gateway', path: 'kappa-code:gateway-display', method: 'GET', service: 'kappa-code', field: 'kilo-gateway-display-name' },
    { id: 'ep-repo-remote', path: 'repo:remote-config', method: 'GET', service: 'ranch-ci', field: 'upstream-remote-target' },
  ];
  for (const ep of endpoints) {
    await execute(
      `MATCH (s:Service {name: $service})
       CREATE (e:Endpoint {id: $id, path: $path, method: $method})<-[:EXPOSES]-(s)`,
      ep
    );
  }

  // Consumer contracts (downstream blast-radius paths)
  console.log(`[ESTATE-SEED] 5/7 Wiring downstream consumer contracts...`);
  const deps = [
    { consumer: 'model-guard', consumesPath: 'hodos:/v1/models' },
    { consumer: 'bidder-fleet', consumesPath: 'hodos:/v1/models' },
    { consumer: 'bidder-fleet', consumesPath: 'hodos:/v1/chat/completions' },
    { consumer: 'oracle-market', consumesPath: 'hodos:/v1/chat/completions' },
    { consumer: 'gatehouse', consumesPath: 'hodos:/v1/models' },
    { consumer: 'executor', consumesPath: 'oracle-market:/ledger/settle' },
    { consumer: 'kappa-code', consumesPath: 'kappa-code:gateway-display' },
    { consumer: 'ranch-ci', consumesPath: 'repo:remote-config' },
  ];
  for (const d of deps) {
    await execute(
      `MATCH (consumer:Service {name: $consumer}), (ep:Endpoint {path: $consumesPath})
       CREATE (consumer)-[:CONSUMES]->(ep)`,
      d
    );
  }

  // Step 6: Governed SchemaFields + ADR links
  console.log(`[ESTATE-SEED] 6/7 Creating governed schema fields...`);
  const fields = [
    { id: 'field-hodos-port', name: 'hodos-api-port', data_type: 'port', description: 'hodos API listen port — pinned by EST-001', usedInEndpoints: ['hodos:/v1/models', 'hodos:/v1/chat/completions'] },
    { id: 'field-kilo-name', name: 'kilo-gateway-display-name', data_type: 'string', description: 'Kilo Gateway display name — kilo.ai external, invariant per EST-002', usedInEndpoints: ['kappa-code:gateway-display'] },
    { id: 'field-settle-source', name: 'settle-claim-source', data_type: 'string', description: 'source of truth for settle claims — oracle ledger per EST-003', usedInEndpoints: ['oracle-market:/ledger/settle'] },
    { id: 'field-push-target', name: 'upstream-remote-target', data_type: 'string', description: 'repo push target — toxicwind forks canonical per EST-004', usedInEndpoints: ['repo:remote-config'] },
  ];
  for (const f of fields) {
    await execute(
      `CREATE (ff:SchemaField {id: $id, name: $name, data_type: $data_type, description: $description})`,
      { id: f.id, name: f.name, data_type: f.data_type, description: f.description }
    );
    for (const epPath of f.usedInEndpoints) {
      await execute(
        `MATCH (ep:Endpoint {path: $epPath}), (ff:SchemaField {name: $fieldName})
         CREATE (ep)-[:USES_FIELD]->(ff)`,
        { epPath, fieldName: f.name }
      );
    }
  }

  await execute(`MATCH (a:ADR {code: 'EST-001'}), (f:SchemaField {name: 'hodos-api-port'}) CREATE (a)-[:GOVERNS]->(f)`);
  await execute(`MATCH (a:ADR {code: 'EST-002'}), (f:SchemaField {name: 'kilo-gateway-display-name'}) CREATE (a)-[:GOVERNS]->(f)`);
  await execute(`MATCH (a:ADR {code: 'EST-003'}), (f:SchemaField {name: 'settle-claim-source'}) CREATE (a)-[:GOVERNS]->(f)`);
  await execute(`MATCH (a:ADR {code: 'EST-004'}), (f:SchemaField {name: 'upstream-remote-target'}) CREATE (a)-[:GOVERNS]->(f)`);

  // Step 7: Episodic memory — real estate incident tied to EST-001
  console.log(`[ESTATE-SEED] 7/7 Seeding estate episodic memory...`);
  await execute(
    `MATCH (a:ADR {code: 'EST-001'})
     CREATE (e:ArchitecturalEpisode {
       id: 'est-ep-001', code: 'EPISODE-EST-001', incident_id: 'INC-2026-1019',
       title: 'model-guard 502 flap: dead herd default upstream',
       summary: 'model-guard TS port defaulted MODEL_GUARD_UPSTREAM to dead herd :25100; ' +
         'pitchfork health checks 502d into a ~100s restart loop. Fixed at the source with ' +
         'fail-fast requiredUpstream() (estate 465f3e2a19) so an unset upstream kills the process ' +
         'at boot instead of serving 502s silently.',
       workaround_pattern: 'fail-fast at boot: requiredX() exits 1 when a critical env is unset; ' +
         'health endpoints stay purely local so downstream health is never conflated.',
       approved_by: 'chris', resolution_date: '2026-10-19',
       trade_offs: 'misconfigured deploys crash-loop at boot instead of running degraded; ' +
         'pitchfork retry makes this loud and visible.'
     })-[:APPLIES_TO]->(a)`
  );

  const countNodesRes = await execute(`MATCH (n) RETURN count(n) as total`);
  const countEdgesRes = await execute(`MATCH ()-[r]->() RETURN count(r) as total`);
  const totalNodes = (countNodesRes.data?.[0] as any)?.total ?? 0;
  const totalEdges = (countEdgesRes.data?.[0] as any)?.total ?? 0;

  console.log(`\n============================================================`);
  console.log(`[ESTATE-SEED COMPLETED] Nodes: ${totalNodes}, Edges: ${totalEdges}`);
  console.log(`============================================================\n`);

  return {
    adrsCount: adrs.length,
    teamsCount: teams.length,
    personsCount: persons.length,
    servicesCount: services.length,
    endpointsCount: endpoints.length,
    schemaFieldsCount: fields.length,
    episodesCount: 1,
    relationshipsCount: totalEdges,
  };
}

const isDirectRun =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    process.argv[1].includes('seedEstate'));

if (isDirectRun) {
  seedEstateDatabase()
    .then(async (summary) => {
      console.log(JSON.stringify(summary));
      await closeFalkorClient();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Estate seed failed:', err);
      await closeFalkorClient();
      process.exit(1);
    });
}
