import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { getGraph, deleteGraph, closeFalkorClient } from './falkor.js';
import { ADRFrontmatter } from '../types/index.js';

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

export async function seedDatabase(tenantGraphName?: string): Promise<SeedSummary> {
  console.log(`\n============================================================`);
  console.log(`[SEED] Initializing ArchGuard Brain in FalkorDB...`);
  console.log(`============================================================`);

  // Step 1: Wipe clean
  console.log(`[SEED] 1/7 Cleaning previous graph state...`);
  await deleteGraph(tenantGraphName);

  const graph = await getGraph(tenantGraphName);

  // Helper function to safely execute Cypher
  const execute = async (cypher: string, params?: Record<string, any>) => {
    return graph.query(cypher, params ? { params } : undefined);
  };

  // Step 2: Read and parse real Markdown ADR files from /data/adrs/
  console.log(`[SEED] 2/7 Ingesting real Markdown ADR files from /data/adrs/...`);
  const adrsDir = path.resolve(process.cwd(), 'data', 'adrs');
  const adrFiles = fs.readdirSync(adrsDir).filter((f) => f.endsWith('.md'));

  const parsedAdrs: { data: ADRFrontmatter; content: string }[] = [];
  for (const file of adrFiles) {
    const filePath = path.join(adrsDir, file);
    const rawContent = fs.readFileSync(filePath, 'utf-8');
    const { data, content } = matter(rawContent);
    parsedAdrs.push({ data: data as ADRFrontmatter, content });
  }

  for (const { data, content } of parsedAdrs) {
    await execute(
      `CREATE (a:ADR {
        id: $id,
        code: $code,
        title: $title,
        status: $status,
        rule_type: $rule_type,
        target_property: $target_property,
        expected_value: $expected_value,
        governs_target: $governs_target,
        author_handle: $author_handle,
        content: $content
      })`,
      {
        id: data.id,
        code: data.code,
        title: data.title,
        status: data.status,
        rule_type: data.rule_type,
        target_property: data.target_property,
        expected_value: data.expected_value,
        governs_target: data.governs_target,
        author_handle: data.author_handle,
        content: content.trim(),
      }
    );
    console.log(`   + Created :ADR [${data.code}] "${data.title}" (Rule: ${data.rule_type})`);
  }

  // Step 3: Seed FinCore Teams & Persons
  console.log(`[SEED] 3/7 Seeding FinCore Teams and Engineers...`);
  const teams = [
    {
      id: 'team-identity',
      name: 'Identity-Core',
      slack_channel: '#team-identity-core',
      domain: 'Identity & Access Management',
    },
    {
      id: 'team-billing',
      name: 'Billing-Platform',
      slack_channel: '#team-billing-platform',
      domain: 'Billing & Subscriptions',
    },
    {
      id: 'team-checkout',
      name: 'Checkout-Experience',
      slack_channel: '#team-checkout-exp',
      domain: 'Checkout & Cart Experience',
    },
    {
      id: 'team-ledger',
      name: 'Ledger-Ops',
      slack_channel: '#team-ledger-ops',
      domain: 'Financial Ledger & Reconciliation',
    },
  ];

  for (const team of teams) {
    await execute(
      `CREATE (t:Team {
        id: $id,
        name: $name,
        slack_channel: $slack_channel,
        domain: $domain
      })`,
      team
    );
  }

  const persons = [
    {
      id: 'p-alex',
      handle: 'alex_lead',
      name: 'Alex Vance',
      role: 'Tech Lead',
      email: 'alex@fincore.internal',
      team: 'Identity-Core',
    },
    {
      id: 'p-sam',
      handle: 'sam_platform',
      name: 'Sam Rivera',
      role: 'Staff Engineer',
      email: 'sam@fincore.internal',
      team: 'Billing-Platform',
    },
    {
      id: 'p-priya',
      handle: 'priya_fin',
      name: 'Priya Sharma',
      role: 'Principal Architect',
      email: 'priya@fincore.internal',
      team: 'Ledger-Ops',
    },
    {
      id: 'p-dave',
      handle: 'dave_eng',
      name: 'Dave Chen',
      role: 'Tech Lead',
      email: 'dave@fincore.internal',
      team: 'Checkout-Experience',
    },
    {
      id: 'p-elena',
      handle: 'elena_dev',
      name: 'Elena Rostova',
      role: 'Senior Backend Engineer',
      email: 'elena@fincore.internal',
      team: 'Billing-Platform',
    },
  ];

  for (const person of persons) {
    await execute(
      `MATCH (t:Team {name: $team})
       CREATE (p:Person {
         id: $id,
         handle: $handle,
         name: $name,
         role: $role,
         email: $email
       })-[:MEMBER_OF]->(t)`,
      person
    );

    // Link Person to ADRs authored
    await execute(
      `MATCH (p:Person {handle: $handle}), (a:ADR {author_handle: $handle})
       CREATE (p)-[:AUTHORED]->(a)`,
      { handle: person.handle }
    );
  }

  // Step 4: Seed Services & Endpoints
  console.log(`[SEED] 4/7 Seeding FinCore Microservices and Endpoints...`);
  const services = [
    {
      id: 'svc-auth',
      name: 'auth-service',
      tier: 'tier-1',
      description: 'Core identity authentication and token generation',
      team: 'Identity-Core',
    },
    {
      id: 'svc-billing',
      name: 'billing-service',
      tier: 'tier-1',
      description: 'Recurring subscription billing and customer invoices',
      team: 'Billing-Platform',
    },
    {
      id: 'svc-checkout',
      name: 'checkout-service',
      tier: 'tier-1',
      description: 'Checkout cart orchestration and payments session',
      team: 'Checkout-Experience',
    },
    {
      id: 'svc-gateway',
      name: 'payment-gateway',
      tier: 'tier-1',
      description: 'Inbound webhook receiver and PSP communication',
      team: 'Billing-Platform',
    },
    {
      id: 'svc-ledger',
      name: 'ledger-service',
      tier: 'tier-1',
      description: 'Double-entry immutable financial balance books',
      team: 'Ledger-Ops',
    },
  ];

  for (const svc of services) {
    await execute(
      `MATCH (t:Team {name: $team})
       CREATE (s:Service {
         id: $id,
         name: $name,
         tier: $tier,
         description: $description
       })<-[:OWNS]-(t)`,
      svc
    );
  }

  const endpoints = [
    {
      id: 'ep-users',
      path: '/v1/users',
      method: 'POST',
      service: 'auth-service',
    },
    {
      id: 'ep-webhooks-payment',
      path: '/v1/webhooks/payment',
      method: 'POST',
      execution_mode: 'async_queue',
      service: 'payment-gateway',
    },
    {
      id: 'ep-ledger-entries',
      path: '/v1/ledger/entries',
      method: 'POST',
      contract_policy: 'backward_compatible',
      service: 'ledger-service',
    },
    {
      id: 'ep-checkout-session',
      path: '/v1/checkout/session',
      method: 'POST',
      service: 'checkout-service',
    },
    {
      id: 'ep-billing-subscriptions',
      path: '/v1/billing/subscriptions',
      method: 'POST',
      service: 'billing-service',
    },
  ];

  for (const ep of endpoints) {
    await execute(
      `MATCH (s:Service {name: $service})
       CREATE (e:Endpoint {
         id: $id,
         path: $path,
         method: $method,
         execution_mode: $execution_mode,
         contract_policy: $contract_policy
       })<-[:EXPOSES]-(s)`,
      {
        id: ep.id,
        path: ep.path,
        method: ep.method,
        service: ep.service,
        execution_mode: ep.execution_mode || 'default',
        contract_policy: ep.contract_policy || 'standard',
      }
    );
  }

  // Cross-Service Consumption Contracts (Downstream Blast Radius Paths)
  console.log(`[SEED] 5/7 Wiring downstream microservice consumer contracts...`);
  const serviceDependencies = [
    { consumer: 'billing-service', consumesPath: '/v1/users' },
    { consumer: 'checkout-service', consumesPath: '/v1/users' },
    { consumer: 'checkout-service', consumesPath: '/v1/billing/subscriptions' },
    { consumer: 'payment-gateway', consumesPath: '/v1/ledger/entries' },
    { consumer: 'billing-service', consumesPath: '/v1/ledger/entries' },
  ];

  for (const dep of serviceDependencies) {
    await execute(
      `MATCH (consumer:Service {name: $consumer}), (ep:Endpoint {path: $consumesPath})
       CREATE (consumer)-[:CONSUMES]->(ep)`,
      dep
    );
  }

  // Step 5: Seed Schema Fields & link [:USES_FIELD]
  console.log(`[SEED] 6/7 Seeding SchemaFields and governing ADR policies...`);
  const schemaFields = [
    {
      id: 'field-user-id',
      name: 'user_id',
      data_type: 'UUIDv4',
      description: 'Canonical user identifier across FinCore microservices',
      usedInEndpoints: ['/v1/users', '/v1/ledger/entries', '/v1/billing/subscriptions'],
    },
    {
      id: 'field-payment-webhook-mode',
      name: 'payment_webhook_mode',
      data_type: 'String',
      execution_mode: 'async_queue',
      description: 'Execution concurrency mode for payment webhook ingestion',
      usedInEndpoints: ['/v1/webhooks/payment'],
    },
    {
      id: 'field-transaction-amount',
      name: 'transaction_amount',
      data_type: 'Decimal128',
      description: 'Double-entry ledger transaction amount in fixed precision',
      usedInEndpoints: ['/v1/ledger/entries'],
    },
  ];

  for (const field of schemaFields) {
    await execute(
      `CREATE (f:SchemaField {
        id: $id,
        name: $name,
        data_type: $data_type,
        description: $description
      })`,
      {
        id: field.id,
        name: field.name,
        data_type: field.data_type,
        description: field.description,
      }
    );

    // Link Endpoints -> SchemaField
    for (const epPath of field.usedInEndpoints) {
      await execute(
        `MATCH (ep:Endpoint {path: $epPath}), (f:SchemaField {name: $fieldName})
         CREATE (ep)-[:USES_FIELD]->(f)`,
        { epPath, fieldName: field.name }
      );
    }
  }

  // Link ADRs to their governed target (either SchemaField or Endpoint)
  // ADR-001 -> user_id (SchemaField)
  await execute(`
    MATCH (a:ADR {code: 'ADR-001'}), (f:SchemaField {name: 'user_id'})
    CREATE (a)-[:GOVERNS]->(f)
  `);

  // ADR-002 -> /v1/webhooks/payment (Endpoint)
  await execute(`
    MATCH (a:ADR {code: 'ADR-002'}), (ep:Endpoint {path: '/v1/webhooks/payment'})
    CREATE (a)-[:GOVERNS]->(ep)
  `);

  // ADR-003 -> transaction_amount (SchemaField)
  await execute(`
    MATCH (a:ADR {code: 'ADR-003'}), (f:SchemaField {name: 'transaction_amount'})
    CREATE (a)-[:GOVERNS]->(f)
  `);

  // ADR-004 -> /v1/ledger/entries (Endpoint)
  await execute(`
    MATCH (a:ADR {code: 'ADR-004'}), (ep:Endpoint {path: '/v1/ledger/entries'})
    CREATE (a)-[:GOVERNS]->(ep)
  `);

  // Step 6: Episodic Memory (:ArchitecturalEpisode)
  console.log(`[SEED] 7/7 Seeding Episodic Memory nodes (past architectural compromises)...`);
  const episodes = [
    {
      id: 'ep-001',
      code: 'EPISODE-001',
      incident_id: 'INC-2023-42',
      title: 'Dual-Write Shadow Column Pattern for User UUID Migration',
      summary: 'In 2023, migrating high-throughput MySQL shards from Int64 to UUIDv4 caused severe replication lag. Team introduced a transient dual-write shadow column with background backfill and zero-downtime cutover.',
      workaround_pattern: 'Dual-Write Shadow Column Pattern: Keep legacy column, introduce shadow UUID column, dual-write for 14 days, backfill historical rows via CDC, then flip reads.',
      approved_by: 'alex_lead',
      resolution_date: '2023-08-14',
      trade_offs: 'Temporary 30% storage overhead and dual-write latency during the 14-day migration window.',
      adrCode: 'ADR-001',
    },
    {
      id: 'ep-002',
      code: 'EPISODE-002',
      incident_id: 'INC-2023-88',
      title: 'Dead Letter Queue with Exponential Backoff for Payment Webhooks',
      summary: 'Inbound payment partner retries caused cascading timeouts on synchronous webhook workers. Resolved by enforcing async ingress with Redis Streams + DLQ retry workers.',
      workaround_pattern: 'Asynchronous Ingress with Dead Letter Queue: Accept payload immediately with 202 Accepted, push to Redis Streams queue, process in worker pool with 5-stage exponential backoff and DLQ alerting.',
      approved_by: 'sam_platform',
      resolution_date: '2023-11-20',
      trade_offs: 'Client receives 202 Accepted without immediate final confirmation; requires webhook status polling or secondary event notification.',
      adrCode: 'ADR-002',
    },
  ];

  for (const ep of episodes) {
    await execute(
      `MATCH (a:ADR {code: $adrCode})
       CREATE (e:ArchitecturalEpisode {
         id: $id,
         code: $code,
         incident_id: $incident_id,
         title: $title,
         summary: $summary,
         workaround_pattern: $workaround_pattern,
         approved_by: $approved_by,
         resolution_date: $resolution_date,
         trade_offs: $trade_offs
       })-[:APPLIES_TO]->(a)`,
      ep
    );
  }

  // Count graph nodes and edges
  const countNodesRes = await execute(`MATCH (n) RETURN count(n) as total`);
  const countEdgesRes = await execute(`MATCH ()-[r]->() RETURN count(r) as total`);

  const totalNodes = (countNodesRes.data?.[0] as any)?.total ?? 0;
  const totalEdges = (countEdgesRes.data?.[0] as any)?.total ?? 0;

  console.log(`\n============================================================`);
  console.log(`[SEED COMPLETED SUCCESSFULLY]`);
  console.log(`Total FalkorDB Nodes Created: ${totalNodes}`);
  console.log(`Total FalkorDB Edges Created: ${totalEdges}`);
  console.log(`============================================================\n`);

  return {
    adrsCount: parsedAdrs.length,
    teamsCount: teams.length,
    personsCount: persons.length,
    servicesCount: services.length,
    endpointsCount: endpoints.length,
    schemaFieldsCount: schemaFields.length,
    episodesCount: episodes.length,
    relationshipsCount: totalEdges,
  };
}

// Allow standalone execution
import { fileURLToPath } from 'url';

const isDirectRun =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    process.argv[1].includes('seed'));

if (isDirectRun) {
  seedDatabase()
    .then(async () => {
      await closeFalkorClient();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Seed script failed:', err);
      await closeFalkorClient();
      process.exit(1);
    });
}

