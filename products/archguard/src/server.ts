import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { getGraph, DEFAULT_GRAPH_NAME } from './db/falkor.js';
import { seedDatabase } from './db/seed.js';
import {
  getFullGraphTopology,
  ingestNewMarkdownAdr,
  recordNewArchitecturalEpisode,
} from './engine/graphManager.js';
import { runFullAuditWorkflow } from './agents/orchestrator.js';
import { LLMOptions } from './types/index.js';

dotenv.config();

export const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// 1. GET /api/health
// ---------------------------------------------------------------------------
app.get('/api/health', async (req: Request, res: Response) => {
  try {
    const tenant = (req.query.tenant as string) || DEFAULT_GRAPH_NAME;
    const graph = await getGraph(tenant);

    const [nodesRes, edgesRes] = await Promise.all([
      graph.query(`MATCH (n) RETURN count(n) as total`),
      graph.query(`MATCH ()-[r]->() RETURN count(r) as total`),
    ]);

    const totalNodes = (nodesRes.data?.[0] as any)?.total ?? 0;
    const totalEdges = (edgesRes.data?.[0] as any)?.total ?? 0;

    res.json({
      status: 'healthy',
      falkordb: 'connected',
      tenantGraphName: tenant,
      graphStats: { totalNodes, totalEdges },
      llmProviders: {
        openrouter: Boolean(process.env.OPENROUTER_API_KEY),
        gemini: Boolean(process.env.GEMINI_API_KEY),
        deterministicFallback: true,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 2. GET /api/graph
// ---------------------------------------------------------------------------
app.get('/api/graph', async (req: Request, res: Response) => {
  try {
    const tenant = req.query.tenant as string | undefined;
    const topology = await getFullGraphTopology(tenant);
    res.json(topology);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 3. GET /api/presets
// ---------------------------------------------------------------------------
app.get('/api/presets', (_req: Request, res: Response) => {
  const presets = [
    {
      id: 'preset-uuid-int64',
      code: 'PR-409',
      title: 'PR #409: Migrate user_id from UUIDv4 to Int64 in auth-service',
      description: 'Proposes changing primary user_id from UUIDv4 to sequential 64-bit integer to optimize memory.',
      expectedConflict: 'Violates ADR-001 (UUIDv4 mandate) and breaks 3 downstream services across Billing & Checkout.',
      rawInput: `diff --git a/schemas/user.proto b/schemas/user.proto
--- a/schemas/user.proto
+++ b/schemas/user.proto
@@ -12,3 +12,3 @@ message UserProfile {
-  string user_id = 1; // UUIDv4 RFC 4122
+  int64 user_id = 1; // Optimized sequential 64-bit ID
}`,
    },
    {
      id: 'preset-webhook-sync',
      code: 'PR-512',
      title: 'PR #512: Implement synchronous inline retry loop on payment webhooks',
      description: 'Proposes replacing async queue processing with synchronous RPC retries on partner webhook ingestion.',
      expectedConflict: 'Violates ADR-002 (mandates async_queue mode) and risks cascading worker exhaustion.',
      rawInput: `openapi: 3.0.3
paths:
  /v1/webhooks/payment:
    post:
      summary: Inbound partner webhook receiver
      x-execution-mode: synchronous_inline
      x-retry-policy: inline_exponential_rpc_wait
      responses:
        '200':
          description: Processed synchronously inline`,
    },
    {
      id: 'preset-decimal-float',
      code: 'PR-601',
      title: 'PR #601: Change transaction_amount precision from Decimal128 to Float64',
      description: 'Proposes utilizing native IEEE 754 float64 instead of high-precision Decimal128 for ledger amounts.',
      expectedConflict: 'Violates ADR-003 (mandates Decimal128) and triggers reconciliation rounding discrepancy.',
      rawInput: `ALTER TABLE ledger_entries 
MODIFY COLUMN transaction_amount DOUBLE PRECISION NOT NULL;
-- Replaces Decimal128 with IEEE 754 Float64 for math performance`,
    },
  ];

  res.json({ presets });
});

// ---------------------------------------------------------------------------
// 4. POST /api/audit
// ---------------------------------------------------------------------------
app.post('/api/audit', async (req: Request, res: Response) => {
  try {
    const { rawInput, title, tenant } = req.body;

    if (!rawInput || typeof rawInput !== 'string') {
      return res.status(400).json({ error: 'Missing required field: rawInput (string).' });
    }

    const options: LLMOptions = {};
    const headerKey = req.headers['x-api-key'] as string | undefined;
    const headerProvider = req.headers['x-llm-provider'] as 'openrouter' | 'gemini' | undefined;

    if (headerKey) {
      options.runtimeKey = headerKey;
      options.runtimeProvider = headerProvider || 'openrouter';
    }

    const auditPayload = await runFullAuditWorkflow(rawInput, title, options, tenant);
    res.json(auditPayload);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 5. POST /api/episodes
// ---------------------------------------------------------------------------
app.post('/api/episodes', async (req: Request, res: Response) => {
  try {
    const {
      code,
      incident_id,
      title,
      summary,
      workaround_pattern,
      approved_by,
      resolution_date,
      trade_offs,
      adrCode,
      tenant,
    } = req.body;

    if (!code || !incident_id || !title || !workaround_pattern) {
      return res.status(400).json({
        error: 'Missing required fields: code, incident_id, title, workaround_pattern.',
      });
    }

    const result = await recordNewArchitecturalEpisode(
      {
        id: code,
        code,
        incident_id,
        title,
        summary: summary || '',
        workaround_pattern,
        approved_by: approved_by || 'architecture_lead',
        resolution_date: resolution_date || new Date().toISOString().split('T')[0],
        trade_offs: trade_offs || 'Documented trade-offs in episode log.',
        adrCode: adrCode || 'ADR-001',
      },
      tenant
    );

    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 6. POST /api/adrs/ingest
// ---------------------------------------------------------------------------
app.post('/api/adrs/ingest', async (req: Request, res: Response) => {
  try {
    const { markdownContent, filename, tenant } = req.body;

    if (!markdownContent) {
      return res.status(400).json({ error: 'Missing required field: markdownContent.' });
    }

    const targetFilename = filename || `ADR-custom-${Date.now()}.md`;
    const result = await ingestNewMarkdownAdr(markdownContent, targetFilename, tenant);

    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// 7. POST /api/graph/reset
// ---------------------------------------------------------------------------
app.post('/api/graph/reset', async (req: Request, res: Response) => {
  try {
    const tenant = req.body?.tenant as string | undefined;
    const stats = await seedDatabase(tenant);
    res.json({ success: true, message: 'FalkorDB reset and seeded cleanly.', stats });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Start server if executed directly
const PORT = process.env.PORT || 4000;
export function startServer(port: number | string = PORT) {
  return app.listen(port, () => {
    console.log(`\n🚀 ArchGuard Express API Server running on http://localhost:${port}`);
    console.log(`   - Health check:     GET  /api/health`);
    console.log(`   - Graph Topology:   GET  /api/graph`);
    console.log(`   - Presets:          GET  /api/presets`);
    console.log(`   - 3-Agent Audit:    POST /api/audit`);
    console.log(`   - Episodic Memory:  POST /api/episodes`);
    console.log(`   - ADR Ingestion:    POST /api/adrs/ingest`);
    console.log(`   - Reset Seed:       POST /api/graph/reset\n`);
  });
}

// Standalone entrypoint check
import { fileURLToPath } from 'url';
import path from 'path';

const isMain =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    process.argv[1].includes('server'));

if (isMain) {
  startServer();
}
