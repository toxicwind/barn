import React, { useState } from 'react';
import { X, FileText, CheckCircle2, Sparkles } from 'lucide-react';
import { ingestAdr } from '../api';

interface IngestAdrModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

const SAMPLE_NEW_ADR = `---
id: "ADR-005"
code: "ADR-005"
title: "Mandate Idempotency Keys on Payment Ingress Endpoints"
status: "ACCEPTED"
rule_type: "ENDPOINT_EXECUTION_MODE"
target_property: "execution_mode"
expected_value: "idempotent_keyed"
governs_target: "/v1/webhooks/payment"
author_handle: "sam_platform"
---

# ADR-005: Mandate Idempotency Keys on Payment Ingress Endpoints

## Status
ACCEPTED (Active & Enforced)

## Context
Payment webhook duplication can cause double-charging or duplicate credits.

## Decision
All payment ingress endpoints MUST validate RFC-compliant idempotency tokens.
`;

export const IngestAdrModal: React.FC<IngestAdrModalProps> = ({ isOpen, onClose, onSuccess }) => {
  const [markdown, setMarkdown] = useState(SAMPLE_NEW_ADR);
  const [filename, setFilename] = useState('ADR-005-idempotency.md');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleIngest = async () => {
    setIsLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await ingestAdr(markdown, filename);
      setSuccessMsg(`Successfully ingested ${res.adrCode} into FalkorDB!`);
      setTimeout(() => {
        onSuccess();
        onClose();
      }, 1200);
    } catch (err: any) {
      setError(err.message || 'Failed to ingest ADR');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-2xl bg-[#0a0a0a] border border-white/[0.12] rounded-2xl p-5 shadow-2xl space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-white/[0.08]">
          <div className="flex items-center space-x-2">
            <div className="w-7 h-7 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-center justify-center">
              <FileText className="w-4 h-4 text-amber-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Ingest Real Markdown ADR (.md)</h3>
              <p className="text-[11px] text-neutral-400 font-mono">
                Parses YAML frontmatter & connects :ADR node into FalkorDB
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-neutral-800 rounded text-neutral-400 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-500/40 text-xs text-rose-300 font-mono">
            {error}
          </div>
        )}

        {successMsg && (
          <div className="p-3 rounded-lg bg-emerald-950/40 border border-emerald-500/40 text-xs text-emerald-300 font-mono flex items-center space-x-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>{successMsg}</span>
          </div>
        )}

        <div className="space-y-1.5">
          <label className="text-[11px] uppercase font-mono text-neutral-400 block">Target Filename</label>
          <input
            type="text"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            className="w-full bg-[#050505] text-xs font-mono text-white p-2.5 rounded-lg border border-white/[0.08] focus:outline-none focus:border-amber-500/50"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-[11px] uppercase font-mono text-neutral-400 block">
            Markdown ADR Content (YAML Frontmatter + Decision Body)
          </label>
          <textarea
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            rows={10}
            className="w-full bg-[#050505] text-xs font-mono text-neutral-200 p-3 rounded-lg border border-white/[0.08] focus:outline-none focus:border-amber-500/50 leading-relaxed resize-none"
          />
        </div>

        <div className="flex justify-end space-x-2 pt-2 border-t border-white/[0.06]">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-mono rounded-lg border border-white/[0.08] text-neutral-300 hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            onClick={handleIngest}
            disabled={isLoading || !markdown.trim()}
            className="px-4 py-2 text-xs font-mono font-bold rounded-lg bg-amber-500 hover:bg-amber-400 text-black flex items-center space-x-1.5 transition-all shadow-[0_0_15px_rgba(245,158,11,0.3)] disabled:opacity-50"
          >
            {isLoading ? <Sparkles className="w-3.5 h-3.5 animate-spin" /> : null}
            <span>{isLoading ? 'Ingesting...' : 'Ingest into FalkorDB'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
