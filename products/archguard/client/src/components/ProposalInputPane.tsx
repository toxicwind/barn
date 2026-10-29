import React, { useState } from 'react';
import { Play, Sparkles, GitPullRequest, ChevronLeft, ChevronRight, FileCode, Check } from 'lucide-react';
import { PresetItem } from '../types';

interface ProposalInputPaneProps {
  presets: PresetItem[];
  selectedPresetId: string | null;
  rawInput: string;
  onSelectPreset: (preset: PresetItem) => void;
  onChangeRawInput: (val: string) => void;
  onExecuteAudit: () => void;
  isAuditing: boolean;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export const ProposalInputPane: React.FC<ProposalInputPaneProps> = ({
  presets,
  selectedPresetId,
  rawInput,
  onSelectPreset,
  onChangeRawInput,
  onExecuteAudit,
  isAuditing,
  isCollapsed = false,
  onToggleCollapse,
}) => {
  const selectedPreset = presets.find((p) => p.id === selectedPresetId);

  // Collapsed View (Ultra-compact sidebar for laptop screens)
  if (isCollapsed) {
    return (
      <div className="flex flex-col items-center h-full py-4 bg-[#050505] border-r border-white/[0.08] w-12 space-y-4">
        <button
          onClick={onToggleCollapse}
          className="p-1.5 rounded-lg bg-neutral-900 border border-white/[0.08] text-neutral-400 hover:text-white"
          title="Expand Spec Editor Drawer"
        >
          <ChevronRight className="w-4 h-4" />
        </button>

        <div className="flex-1 flex flex-col items-center space-y-3 pt-4">
          <div className="text-[10px] font-mono text-neutral-500 [writing-mode:vertical-rl] rotate-180 uppercase tracking-widest">
            Spec Drawer
          </div>

          <div className="w-px h-12 bg-white/[0.08]" />

          {/* Quick Preset Icon Buttons */}
          {presets.map((p) => {
            const isSelected = p.id === selectedPresetId;
            return (
              <button
                key={p.id}
                onClick={() => onSelectPreset(p)}
                className={`w-7 h-7 rounded-md text-[10px] font-mono font-bold flex items-center justify-center border transition-all ${
                  isSelected
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/60 shadow-[0_0_10px_rgba(245,158,11,0.2)]'
                    : 'bg-neutral-900 text-neutral-400 border-white/[0.08] hover:text-white'
                }`}
                title={p.title}
              >
                {p.code.replace('PR-', '')}
              </button>
            );
          })}
        </div>

        <button
          onClick={onExecuteAudit}
          disabled={isAuditing || !rawInput.trim()}
          className="w-8 h-8 rounded-lg bg-amber-500 hover:bg-amber-400 text-black flex items-center justify-center shadow-[0_0_12px_rgba(245,158,11,0.3)] disabled:opacity-50"
          title="Execute 3-Agent Audit"
        >
          {isAuditing ? (
            <Sparkles className="w-4 h-4 animate-spin text-black" />
          ) : (
            <Play className="w-4 h-4 fill-black" />
          )}
        </button>
      </div>
    );
  }

  // Expanded View
  return (
    <div className="flex flex-col h-full bg-[#050505] border-r border-white/[0.08] overflow-hidden">
      {/* Pane Header */}
      <div className="p-3 border-b border-white/[0.08] flex items-center justify-between bg-[#080808]">
        <div className="flex items-center space-x-2">
          <GitPullRequest className="w-4 h-4 text-amber-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-neutral-200">
            PROPOSAL TERMINAL
          </span>
        </div>

        <div className="flex items-center space-x-1.5">
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-neutral-900 border border-white/[0.08] text-neutral-400">
            Diff / OpenAPI / SQL
          </span>
          {onToggleCollapse && (
            <button
              onClick={onToggleCollapse}
              className="p-1 hover:bg-neutral-800 rounded text-neutral-400 hover:text-white transition-all"
              title="Collapse Drawer"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="p-3 space-y-3 flex-1 flex flex-col overflow-hidden">
        {/* COMPACT PRESET SELECTOR (1-Line Horizontal Pills) */}
        <div className="space-y-1.5 flex-shrink-0">
          <div className="flex items-center justify-between text-[10px] font-mono text-neutral-400 px-0.5">
            <span>QUICK PRESETS</span>
            <span className="text-amber-500/80">Select one to load</span>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            {presets.map((preset) => {
              const isSelected = selectedPresetId === preset.id;
              let activeClass = 'bg-[#0a0a0a] border-white/[0.08] text-neutral-400 hover:text-white hover:border-neutral-700';

              if (isSelected) {
                if (preset.code === 'PR-409') {
                  activeClass = 'bg-amber-500/15 border-amber-500/70 text-amber-300 font-bold shadow-[0_0_12px_rgba(245,158,11,0.2)]';
                } else if (preset.code === 'PR-512') {
                  activeClass = 'bg-cyan-500/15 border-cyan-500/70 text-cyan-300 font-bold shadow-[0_0_12px_rgba(6,182,212,0.2)]';
                } else {
                  activeClass = 'bg-emerald-500/15 border-emerald-500/70 text-emerald-300 font-bold shadow-[0_0_12px_rgba(16,185,129,0.2)]';
                }
              }

              const label =
                preset.code === 'PR-409'
                  ? '409 • Schema'
                  : preset.code === 'PR-512'
                  ? '512 • Webhook'
                  : '601 • Precision';

              return (
                <button
                  key={preset.id}
                  onClick={() => onSelectPreset(preset)}
                  className={`py-1.5 px-2 rounded-lg border text-[11px] font-mono transition-all text-center truncate ${activeClass}`}
                  title={preset.title}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Preset / Custom Status Badge */}
          {selectedPreset ? (
            <div
              className="p-2.5 rounded-lg bg-[#090909] border border-white/[0.08] hover:border-amber-500/30 transition-all flex flex-col space-y-1.5 text-xs group"
              title={`${selectedPreset.title}\n\n${selectedPreset.expectedConflict}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-bold text-white text-[11px] leading-snug">
                  {selectedPreset.code}: {selectedPreset.title.split(':')[1]?.trim() || selectedPreset.title}
                </span>
              </div>
              <p className="text-[10px] text-neutral-400 font-sans leading-relaxed">
                {selectedPreset.expectedConflict}
              </p>
            </div>
          ) : (
            <div className="p-2 rounded-lg bg-neutral-900/60 border border-amber-500/30 flex items-center justify-between text-xs">
              <div className="flex items-center space-x-2">
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                <span className="font-mono text-amber-300 text-[11px] font-semibold">Custom / Edited Spec</span>
              </div>
              <span className="text-[10px] text-neutral-400 font-mono">Ready to Audit</span>
            </div>
          )}
        </div>

        {/* Spacious Code/Diff Terminal Editor */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center justify-between px-3 py-1.5 bg-[#0e0e0e] border border-b-0 border-white/[0.08] rounded-t-lg flex-shrink-0">
            <div className="flex items-center space-x-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-rose-500/80" />
              <div className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
              <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
              <span className="text-[10px] font-mono text-neutral-400 ml-2">raw_spec_input</span>
            </div>
            <span className="text-[10px] font-mono text-neutral-500">Live Editor</span>
          </div>

          <textarea
            value={rawInput}
            onChange={(e) => onChangeRawInput(e.target.value)}
            placeholder="Paste raw PR diff, OpenAPI spec, or SQL migration..."
            className="flex-1 w-full bg-[#050505] text-neutral-200 font-mono text-xs p-3 border border-white/[0.08] rounded-b-lg resize-none focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/30 leading-relaxed transition-all"
            spellCheck={false}
          />
        </div>

        {/* High-Contrast Glowing Primary Button */}
        <button
          onClick={onExecuteAudit}
          disabled={isAuditing || !rawInput.trim()}
          className="w-full relative group overflow-hidden rounded-lg p-[1px] font-semibold text-xs transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_0_20px_rgba(245,158,11,0.25)] hover:shadow-[0_0_25px_rgba(245,158,11,0.4)] flex-shrink-0"
        >
          <div className="absolute inset-0 bg-gradient-to-r from-amber-500 via-yellow-400 to-amber-600 rounded-lg animate-pulse" />
          <div className="relative flex items-center justify-center space-x-2 bg-neutral-950 py-2.5 px-4 rounded-[7px] text-white hover:bg-neutral-900/90 transition-all">
            {isAuditing ? (
              <>
                <Sparkles className="w-4 h-4 text-amber-400 animate-spin" />
                <span className="tracking-wide font-mono text-amber-300">
                  Auditing FalkorDB...
                </span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4 fill-amber-400 text-amber-400 group-hover:translate-x-0.5 transition-transform" />
                <span className="tracking-wide uppercase font-mono text-amber-300">
                  ⚡ Execute 3-Agent Audit
                </span>
              </>
            )}
          </div>
        </button>
      </div>
    </div>
  );
};
