import { FullAuditPayload, GraphTopology, PresetItem } from './types';

const API_BASE = '/api';

export async function fetchHealth() {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) throw new Error(`Health check failed: HTTP ${res.status}`);
  return res.json();
}

export async function fetchGraph(tenant?: string): Promise<GraphTopology> {
  const url = tenant ? `${API_BASE}/graph?tenant=${encodeURIComponent(tenant)}` : `${API_BASE}/graph`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch graph: HTTP ${res.status}`);
  return res.json();
}

export async function fetchPresets(): Promise<PresetItem[]> {
  const res = await fetch(`${API_BASE}/presets`);
  if (!res.ok) throw new Error(`Failed to fetch presets: HTTP ${res.status}`);
  const data = await res.json();
  return data.presets || [];
}

export async function executeAudit(
  rawInput: string,
  title?: string,
  runtimeConfig?: { apiKey?: string; provider?: 'openrouter' | 'gemini' },
  tenant?: string
): Promise<FullAuditPayload> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (runtimeConfig?.apiKey) {
    headers['x-api-key'] = runtimeConfig.apiKey;
    if (runtimeConfig.provider) {
      headers['x-llm-provider'] = runtimeConfig.provider;
    }
  }

  const res = await fetch(`${API_BASE}/audit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ rawInput, title, tenant }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Audit failed (HTTP ${res.status}): ${errText}`);
  }

  return res.json();
}

export async function ingestAdr(markdownContent: string, filename?: string, tenant?: string) {
  const res = await fetch(`${API_BASE}/adrs/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdownContent, filename, tenant }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ADR Ingestion failed: ${errText}`);
  }

  return res.json();
}

export async function saveEpisode(episodeData: {
  code: string;
  incident_id: string;
  title: string;
  summary: string;
  workaround_pattern: string;
  approved_by: string;
  resolution_date?: string;
  trade_offs?: string;
  adrCode?: string;
  tenant?: string;
}) {
  const res = await fetch(`${API_BASE}/episodes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(episodeData),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to record episode: ${errText}`);
  }

  return res.json();
}

export async function resetGraph(tenant?: string) {
  const res = await fetch(`${API_BASE}/graph/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to reset graph: ${errText}`);
  }

  return res.json();
}
