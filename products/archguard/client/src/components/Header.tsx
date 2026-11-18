import React from 'react';
import { Shield, Database, Sparkles, FileText, Brain, Key, RotateCcw, ArrowLeft } from 'lucide-react';

interface HeaderProps {
  stats: { totalNodes: number; totalEdges: number } | null;
  graphName: string;
  isAuditing: boolean;
  onOpenIngestAdr: () => void;
  onOpenRecordMemory: () => void;
  onOpenApiKeys: () => void;
  onResetGraph: () => void;
  onBackToLanding?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  stats,
  graphName,
  isAuditing,
  onOpenIngestAdr,
  onOpenRecordMemory,
  onOpenApiKeys,
  onResetGraph,
  onBackToLanding,
}) => {
  return (
    <header className="h-14 border-b border-white/[0.08] bg-[#050505]/90 backdrop-blur-xl px-4 flex items-center justify-between sticky top-0 z-40 select-none">
      {/* Brand & Track Badge */}
      <div className="flex items-center space-x-3">
        <div
          onClick={onBackToLanding}
          className="flex items-center space-x-2.5 cursor-pointer group"
          title="Back to Landing Page Overview"
        >
          <div className="relative">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500/20 via-neutral-900 to-black border border-amber-500/40 group-hover:border-amber-400 flex items-center justify-center shadow-[0_0_15px_rgba(245,158,11,0.25)] transition-all">
              <Shield className="w-4 h-4 text-amber-400" />
            </div>
            <div className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse border-2 border-black" />
          </div>

          <div className="flex flex-col">
            <div className="flex items-center space-x-2">
              <span className="font-bold text-sm tracking-tight text-white group-hover:text-amber-200 transition-colors flex items-center gap-1.5">
                ArchGuard
                <span className="text-[10px] uppercase font-mono px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                  Pre-Merge Guardian
                </span>
              </span>
            </div>
            <span className="text-[10px] text-neutral-400 font-mono tracking-wide">
              WeMakeDevs x FalkorDB • Company Brain Track
            </span>
          </div>
        </div>

        {onBackToLanding && (
          <button
            onClick={onBackToLanding}
            className="hidden lg:flex items-center space-x-1 text-[11px] font-mono text-neutral-400 hover:text-white px-2 py-1 rounded bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] transition-all ml-1"
            title="Return to Landing Page"
          >
            <ArrowLeft className="w-3 h-3 text-neutral-400" />
            <span>Overview</span>
          </button>
        )}

        {/* FalkorDB Connection Pulse */}
        <div className="hidden md:flex items-center space-x-2 pl-4 border-l border-white/[0.08]">
          <div className="flex items-center space-x-1.5 px-2.5 py-1 rounded-full bg-emerald-950/40 border border-emerald-500/30 text-emerald-400 text-[11px] font-mono">
            <Database className="w-3 h-3 animate-pulse text-emerald-400" />
            <span className="font-semibold">{graphName}</span>
            <span className="text-neutral-500">|</span>
            <span className="text-neutral-300">
              {stats ? `${stats.totalNodes} Nodes • ${stats.totalEdges} Edges` : 'Connecting...'}
            </span>
          </div>

          {/* Engine Pill */}
          <div className="flex items-center space-x-1.5 px-2.5 py-1 rounded-full bg-blue-950/30 border border-blue-500/30 text-blue-400 text-[11px] font-mono">
            <Sparkles className="w-3 h-3 text-cyan-400" />
            <span>Deterministic Cypher + OpenRouter</span>
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center space-x-2">
        <button
          onClick={onOpenIngestAdr}
          className="flex items-center space-x-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md bg-neutral-900/80 hover:bg-neutral-800 border border-white/[0.08] hover:border-amber-500/40 text-neutral-200 transition-all shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]"
          title="Upload or paste real Markdown ADRs into FalkorDB"
        >
          <FileText className="w-3.5 h-3.5 text-amber-400" />
          <span className="hidden sm:inline">+ Ingest ADR (.md)</span>
        </button>

        <button
          onClick={onOpenRecordMemory}
          className="flex items-center space-x-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md bg-neutral-900/80 hover:bg-neutral-800 border border-white/[0.08] hover:border-emerald-500/40 text-neutral-200 transition-all shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)]"
          title="Persist past architectural incident compromise into Episodic Memory"
        >
          <Brain className="w-3.5 h-3.5 text-emerald-400" />
          <span className="hidden sm:inline">+ Record Memory</span>
        </button>

        <button
          onClick={onOpenApiKeys}
          className="p-1.5 rounded-md bg-neutral-900/80 hover:bg-neutral-800 border border-white/[0.08] text-neutral-400 hover:text-white transition-all"
          title="Configure Runtime LLM API Keys"
        >
          <Key className="w-3.5 h-3.5" />
        </button>

        <button
          onClick={onResetGraph}
          disabled={isAuditing}
          className="flex items-center space-x-1 text-xs font-medium px-2 py-1.5 rounded-md bg-neutral-900/80 hover:bg-neutral-800 border border-white/[0.08] text-neutral-400 hover:text-rose-400 transition-all disabled:opacity-50"
          title="Reset and re-seed FalkorDB graph cleanly"
        >
          <RotateCcw className={`w-3.5 h-3.5 ${isAuditing ? 'animate-spin' : ''}`} />
          <span className="hidden lg:inline">Reset</span>
        </button>
      </div>
    </header>
  );
};
