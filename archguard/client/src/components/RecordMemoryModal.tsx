import React, { useState } from 'react';
import { X, Brain, CheckCircle2, Sparkles } from 'lucide-react';
import { saveEpisode } from '../api';

interface RecordMemoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  defaultAdrCode?: string;
}

export const RecordMemoryModal: React.FC<RecordMemoryModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  defaultAdrCode = 'ADR-001',
}) => {
  const [code, setCode] = useState(`EPISODE-${Date.now().toString().slice(-3)}`);
  const [incidentId, setIncidentId] = useState(`INC-2024-${Math.floor(Math.random() * 90 + 10)}`);
  const [title, setTitle] = useState('Dynamic Shadow Write & Worker Dual-Verification Compromise');
  const [summary, setSummary] = useState(
    'Resolved zero-downtime cutover without breaking legacy consumers by introducing a temporal shadow column.'
  );
  const [workaroundPattern, setWorkaroundPattern] = useState(
    'Dual-Write Verification Pattern: Write to shadow field asynchronously and verify parity for 7 days before cutover.'
  );
  const [approvedBy, setApprovedBy] = useState('alex_lead');
  const [tradeOffs, setTradeOffs] = useState('Transient storage overhead and background CDC worker load.');
  const [adrCode, setAdrCode] = useState(defaultAdrCode);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSave = async () => {
    setIsLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      await saveEpisode({
        code,
        incident_id: incidentId,
        title,
        summary,
        workaround_pattern: workaroundPattern,
        approved_by: approvedBy,
        trade_offs: tradeOffs,
        adrCode,
      });

      setSuccessMsg(`Persisted ${code} into FalkorDB! Linked to ${adrCode}.`);
      setTimeout(() => {
        onSuccess();
        onClose();
      }, 1200);
    } catch (err: any) {
      setError(err.message || 'Failed to save episode');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-xl bg-[#0a0a0a] border border-white/[0.12] rounded-2xl p-5 shadow-2xl space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-white/[0.08]">
          <div className="flex items-center space-x-2">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
              <Brain className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Record Architectural Episode</h3>
              <p className="text-[11px] text-neutral-400 font-mono">
                Persists past workaround into FalkorDB Episodic Memory (:ArchitecturalEpisode)
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

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-[10px] uppercase font-mono text-neutral-400 block">Incident ID</label>
            <input
              type="text"
              value={incidentId}
              onChange={(e) => setIncidentId(e.target.value)}
              className="w-full bg-[#050505] text-xs font-mono text-white p-2 rounded-lg border border-white/[0.08] focus:outline-none focus:border-emerald-500/50"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] uppercase font-mono text-neutral-400 block">Governing ADR Code</label>
            <select
              value={adrCode}
              onChange={(e) => setAdrCode(e.target.value)}
              className="w-full bg-[#050505] text-xs font-mono text-amber-300 p-2 rounded-lg border border-white/[0.08] focus:outline-none focus:border-emerald-500/50"
            >
              <option value="ADR-001">ADR-001 (UUIDv4 Identifier)</option>
              <option value="ADR-002">ADR-002 (Async Payment Webhook)</option>
              <option value="ADR-003">ADR-003 (Decimal128 Currency)</option>
              <option value="ADR-004">ADR-004 (Event-Driven Ledger)</option>
            </select>
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-[10px] uppercase font-mono text-neutral-400 block">Episode Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full bg-[#050505] text-xs font-mono text-white p-2 rounded-lg border border-white/[0.08] focus:outline-none focus:border-emerald-500/50"
          />
        </div>

        <div className="space-y-1">
          <label className="text-[10px] uppercase font-mono text-neutral-400 block">Approved Workaround Pattern</label>
          <textarea
            value={workaroundPattern}
            onChange={(e) => setWorkaroundPattern(e.target.value)}
            rows={2}
            className="w-full bg-[#050505] text-xs font-mono text-emerald-300 p-2.5 rounded-lg border border-white/[0.08] focus:outline-none focus:border-emerald-500/50 resize-none leading-relaxed"
          />
        </div>

        <div className="space-y-1">
          <label className="text-[10px] uppercase font-mono text-neutral-400 block">Known Trade-offs</label>
          <input
            type="text"
            value={tradeOffs}
            onChange={(e) => setTradeOffs(e.target.value)}
            className="w-full bg-[#050505] text-xs font-mono text-neutral-300 p-2 rounded-lg border border-white/[0.08] focus:outline-none focus:border-emerald-500/50"
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
            onClick={handleSave}
            disabled={isLoading || !title.trim()}
            className="px-4 py-2 text-xs font-mono font-bold rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black flex items-center space-x-1.5 transition-all shadow-[0_0_15px_rgba(16,185,129,0.3)] disabled:opacity-50"
          >
            {isLoading ? <Sparkles className="w-3.5 h-3.5 animate-spin" /> : null}
            <span>{isLoading ? 'Saving...' : 'Persist into Episodic Memory'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
