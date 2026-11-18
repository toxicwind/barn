import { FalkorDB, Graph } from 'falkordb';
import dotenv from 'dotenv';

dotenv.config();

let clientInstance: FalkorDB | null = null;

export const DEFAULT_GRAPH_NAME = process.env.FALKORDB_GRAPH_NAME || 'archguard_brain';

/**
 * Returns a singleton instance of the connected FalkorDB client.
 */
export async function getFalkorClient(): Promise<FalkorDB> {
  if (clientInstance) {
    return clientInstance;
  }

  const host = process.env.FALKORDB_HOST || 'localhost';
  const port = parseInt(process.env.FALKORDB_PORT || '6379', 10);
  const password = process.env.FALKORDB_PASSWORD || '';

  const url = password
    ? `redis://:${password}@${host}:${port}`
    : `redis://${host}:${port}`;

  clientInstance = await FalkorDB.connect({ url });
  return clientInstance;
}

/**
 * Selects and returns a graph instance.
 * Supports multi-tenant isolation via optional tenantGraphName.
 */
export async function getGraph(tenantGraphName?: string): Promise<Graph> {
  const client = await getFalkorClient();
  const graphName = tenantGraphName || DEFAULT_GRAPH_NAME;
  return client.selectGraph(graphName);
}

/**
 * Safely closes the FalkorDB connection pool.
 */
export async function closeFalkorClient(): Promise<void> {
  if (clientInstance) {
    await clientInstance.close();
    clientInstance = null;
  }
}

/**
 * Deletes an entire graph instance (used during clean seeds and test teardowns).
 */
export async function deleteGraph(tenantGraphName?: string): Promise<void> {
  const graph = await getGraph(tenantGraphName);
  try {
    await graph.delete();
  } catch (err: any) {
    // If graph does not exist yet, ignore error or fallback to clear
    if (!err?.message?.includes('Graph does not exist')) {
      await graph.query('MATCH (n) DETACH DELETE n');
    }
  }
}
