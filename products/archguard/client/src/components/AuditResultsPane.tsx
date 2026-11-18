import React, { useState } from 'react';
import {
  AlertTriangle,
  Brain,
  Code2,
  CheckCircle2,
  Copy,
  Check,
  ShieldAlert,
  Server,
  Terminal,
  Cpu,
  BookOpen,
  ArrowRight,
} from 'lucide-react';
import {
  AdrViolationFinding,
  BlastRadiusFinding,
  EpisodicMemoryFinding,
  ResolutionAdvice,
  AgentTrace,
} from '../types';
import { ViewMode } from './GraphCanvas';

interface AuditResultsPaneProps {
  proposalId: string | null;
  status: string | null;
  violations: AdrViolationFinding[];
  blastRadius: BlastRadiusFinding[];
  episodicMemory: EpisodicMemoryFinding[];
  resolution: ResolutionAdvice | null;
  agentTraces: AgentTrace[];
  onOpenRecordMemory: () => void;
  viewMode?: ViewMode;
}

export const AuditResultsPane: React.FC<AuditResultsPaneProps> = ({
  proposalId,
  status,
  violations,
  blastRadius,
  episodicMemory,
  resolution,
  agentTraces,
  onOpenRecordMemory,
  viewMode = 'split',
}) => {
  const [activeTab, setActiveTab] = useState<'blast' | 'memory' | 'cypher'>('blast');
  const [copiedCode, setCopiedCode] = useState(false);

  const handleCopyCode = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const isReportMode = viewMode === 'report';

  return (
    <div className="flex flex-col h-full bg-[#050505] border-l border-white/[0.08] overflow-hidden">
      {/* 3 Tab Header Bar */}
      <div className="flex items-center border-b border-white/[0.08] bg-[#080808] text-xs font-mono select-none flex-shrink-0">
        <button
          onClick={() => setActiveTab('blast')}
          className={`flex-1 py-3 px-3 flex items-center justify-center space-x-1.5 border-b-2 transition-all ${
            activeTab === 'blast'
              ? 'border-rose-500 text-rose-300 bg-rose-950/20 font-semibold'
              : 'border-transparent text-neutral-400 hover:text-white'
          }`}
        >
          <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
          <span>Blast Radius</span>
          {violations.length > 0 && (
            <span className="text-[10px] px-1.5 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/30">
              {violations.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('memory')}
          className={`flex-1 py-3 px-3 flex items-center justify-center space-x-1.5 border-b-2 transition-all ${
            activeTab === 'memory'
              ? 'border-emerald-500 text-emerald-300 bg-emerald-950/20 font-semibold'
              : 'border-transparent text-neutral-400 hover:text-white'
          }`}
        >
          <Brain className="w-3.5 h-3.5 text-emerald-400" />
          <span>Memory & Plan</span>
          {episodicMemory.length > 0 && (
            <span className="text-[10px] px-1.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
              {episodicMemory.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('cypher')}
          className={`flex-1 py-3 px-3 flex items-center justify-center space-x-1.5 border-b-2 transition-all ${
            activeTab === 'cypher'
              ? 'border-cyan-500 text-cyan-300 bg-cyan-950/20 font-semibold'
              : 'border-transparent text-neutral-400 hover:text-white'
          }`}
        >
          <Code2 className="w-3.5 h-3.5 text-cyan-400" />
          <span>Cypher Trace</span>
        </button>
      </div>

      {/* Pane Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Proposal Status Pill */}
        {proposalId && (
          <div className="flex items-center justify-between p-2.5 rounded-lg bg-neutral-900/60 border border-white/[0.08]">
            <div className="flex items-center space-x-2 text-xs font-mono">
              <span className="text-neutral-400">Proposal:</span>
              <span className="text-white font-bold">{proposalId}</span>
            </div>
            <div className="flex items-center space-x-1.5">
              <span
                className={`text-[10px] font-mono px-2 py-0.5 rounded font-semibold border ${
                  status === 'RESOLVED' || status === 'APPROVED'
                    ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                    : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                }`}
              >
                ● {status === 'RESOLVED' || status === 'APPROVED' ? 'APPROVED' : (status || 'CONFLICT_DETECTED')}
              </span>
            </div>
          </div>
        )}

        {/* ------------------------------------------------------------- */}
        {/* TAB 1: BLAST RADIUS & GOLDEN ADRs                             */}
        {/* ------------------------------------------------------------- */}
        {activeTab === 'blast' && (
          <div className="space-y-4">
            {proposalId && violations.length === 0 ? (
              <div className="p-6 rounded-2xl bg-gradient-to-br from-emerald-950/30 to-black border border-emerald-500/40 text-center space-y-3 shadow-[0_0_20px_rgba(16,185,129,0.15)]">
                <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mx-auto text-emerald-400">
                  <CheckCircle2 className="w-6 h-6 text-emerald-400" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-sm font-bold text-white font-mono uppercase tracking-wide">
                    ✓ Architectural Policy Compliant
                  </h3>
                  <p className="text-xs text-neutral-300 max-w-sm mx-auto">
                    Zero ADR violations detected. This proposed change strictly conforms to company architectural invariants and causes 0 downstream service breaks.
                  </p>
                </div>
                <div className="pt-2 flex items-center justify-center gap-2 text-[11px] font-mono text-emerald-400">
                  <span className="px-2.5 py-1 rounded bg-emerald-500/10 border border-emerald-500/20 font-bold">
                    STATUS: APPROVED_PRE_MERGE
                  </span>
                  <span className="px-2.5 py-1 rounded bg-emerald-500/10 border border-emerald-500/20">
                    BLAST RADIUS: 0 CONSUMERS
                  </span>
                </div>
              </div>
            ) : !proposalId ? (
              <div className="text-center py-16 text-neutral-500 space-y-2">
                <CheckCircle2 className="w-8 h-8 text-neutral-600 mx-auto" />
                <p className="text-xs font-mono">No active audit results loaded.</p>
                <p className="text-[11px] text-neutral-600">Select a preset or paste a diff to run an audit.</p>
              </div>
            ) : (
              <div className={isReportMode ? 'grid grid-cols-2 gap-5' : 'space-y-4'}>
                {/* Violated Golden ADRs */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-xs font-mono text-neutral-400">
                    <span className="flex items-center space-x-1.5 text-amber-400 font-semibold">
                      <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                      <span>VIOLATED ARCHITECTURE DECISION RECORDS</span>
                    </span>
                    <span className="text-[10px] text-neutral-500">{violations.length} Rule(s)</span>
                  </div>

                  {violations.map((v, i) => (
                    <div
                      key={i}
                      className="p-3.5 rounded-xl bg-gradient-to-br from-rose-950/20 to-neutral-950 border border-rose-500/40 shadow-[0_0_15px_rgba(244,63,94,0.1)] space-y-2.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/30">
                          {v.adrCode}
                        </span>
                        <span className="text-[11px] font-mono text-neutral-400">
                          Author: @{v.authorHandle}
                        </span>
                      </div>

                      <h4 className="text-xs font-bold text-white">{v.adrTitle}</h4>

                      {/* Value Diff */}
                      <div className="grid grid-cols-2 gap-2 text-[11px] font-mono p-2 rounded-lg bg-black/60 border border-white/[0.06]">
                        <div>
                          <span className="text-neutral-500 block text-[9px] uppercase">Mandated Value</span>
                          <span className="text-emerald-400 font-bold">{v.expectedValue}</span>
                        </div>
                        <div>
                          <span className="text-neutral-500 block text-[9px] uppercase">Proposed Value</span>
                          <span className="text-rose-400 font-bold">{v.proposedValue}</span>
                        </div>
                      </div>

                      <p className="text-[11px] text-neutral-300 leading-relaxed font-sans">{v.explanation}</p>

                      <div className="text-[10px] font-mono text-neutral-400 pt-1 border-t border-white/[0.06] flex items-center justify-between">
                        <span>Owning Team: {v.authorTeam}</span>
                        <span className="text-emerald-400">{v.authorSlackChannel}</span>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Downstream Broken Microservices */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-xs font-mono text-neutral-400">
                    <span className="flex items-center space-x-1.5 text-rose-400 font-semibold">
                      <Server className="w-3.5 h-3.5 text-rose-400" />
                      <span>DOWNSTREAM CONSUMERS IN BLAST RADIUS</span>
                    </span>
                    <span className="text-[10px] text-neutral-500">{blastRadius.length} Service(s)</span>
                  </div>

                  <div className="space-y-2">
                    {blastRadius.map((b, i) => (
                      <div
                        key={i}
                        className="p-3 rounded-lg bg-[#0a0a0a] border border-white/[0.08] hover:border-rose-500/30 transition-all space-y-1.5"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-white flex items-center space-x-1.5">
                            <span className="w-2 h-2 rounded-full bg-rose-500" />
                            <span>{b.serviceName}</span>
                          </span>
                          <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20 font-bold">
                            {b.impactLevel}
                          </span>
                        </div>

                        <div className="text-[11px] font-mono text-neutral-400 flex items-center justify-between">
                          <span>Via Endpoint:</span>
                          <span className="text-cyan-400">{b.viaEndpoint}</span>
                        </div>

                        <div className="text-[10px] font-mono text-neutral-400 flex items-center justify-between pt-1 border-t border-white/[0.04]">
                          <span className="text-neutral-300">{b.owningTeam}</span>
                          <span className="text-emerald-400">{b.slackChannel} • @{b.techLeadHandle}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ------------------------------------------------------------- */}
        {/* TAB 2: EPISODIC MEMORY & REMEDIATION                         */}
        {/* ------------------------------------------------------------- */}
        {activeTab === 'memory' && (
          <div className="space-y-4">
            {!proposalId ? (
              <div className="text-center py-16 text-neutral-500 space-y-2">
                <Brain className="w-8 h-8 text-neutral-600 mx-auto" />
                <p className="text-xs font-mono text-neutral-400">Brain Idle • No Active Audit</p>
                <p className="text-[11px] text-neutral-600">
                  Run an audit on a proposal to recall historical incident precedents from FalkorDB episodic memory.
                </p>
              </div>
            ) : (
              <div className={isReportMode ? 'grid grid-cols-2 gap-5' : 'space-y-4'}>
                {/* Recalled Memory Cards */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between text-xs font-mono text-neutral-400">
                    <span className="flex items-center space-x-1.5 text-emerald-400 font-semibold">
                      <Brain className="w-3.5 h-3.5 text-emerald-400" />
                      <span>RECALLED EPISODIC MEMORY PRECEDENT</span>
                    </span>
                    <span className="text-[10px] text-neutral-500">{episodicMemory.length} Match</span>
                  </div>

                {episodicMemory.length === 0 ? (
                  <div className="p-3.5 rounded-lg bg-[#0a0a0a] border border-white/[0.08] text-xs font-mono text-neutral-400">
                    No historical incident compromises match this ADR rule yet. You can commit a new workaround below.
                  </div>
                ) : (
                  episodicMemory.map((ep, i) => (
                    <div
                      key={i}
                      className="p-3.5 rounded-xl bg-gradient-to-br from-emerald-950/30 to-neutral-950 border border-emerald-500/40 shadow-[0_0_15px_rgba(16,185,129,0.15)] space-y-2.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                          {ep.incidentId}
                        </span>
                        <span className="text-[10px] font-mono text-neutral-400">
                          Approved: @{ep.approvedBy} ({ep.resolutionDate})
                        </span>
                      </div>

                      <h4 className="text-xs font-bold text-white">{ep.title}</h4>

                      <div className="text-[11px] text-neutral-300 font-sans leading-relaxed">
                        {ep.summary}
                      </div>

                      <div className="p-2.5 rounded-lg bg-black/70 border border-emerald-500/20 text-xs font-mono text-emerald-300 space-y-1">
                        <span className="text-[10px] uppercase text-neutral-500 font-bold block">
                          Approved Pattern Solution
                        </span>
                        <p className="leading-relaxed">{ep.workaroundPattern}</p>
                      </div>

                      <div className="text-[10px] font-mono text-neutral-400 pt-1 border-t border-white/[0.06]">
                        <span className="text-amber-400/90 font-medium">Trade-offs:</span> {ep.tradeOffs}
                      </div>
                    </div>
                  ))
                )}

                {/* Commit Workaround to Memory Button */}
                <div className="pt-2">
                  <button
                    onClick={onOpenRecordMemory}
                    className="w-full py-2.5 px-3 rounded-lg bg-emerald-950/40 hover:bg-emerald-900/60 border border-emerald-500/40 text-emerald-300 text-xs font-mono font-semibold flex items-center justify-center space-x-2 transition-all shadow-[0_0_15px_rgba(16,185,129,0.15)]"
                  >
                    <Brain className="w-4 h-4 text-emerald-400" />
                    <span>+ Commit New Workaround to FalkorDB Memory</span>
                  </button>
                </div>
              </div>

              {/* Advisor Remediation Steps */}
              {resolution && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-xs font-mono text-neutral-400">
                    <span className="flex items-center space-x-1.5 text-cyan-400 font-semibold">
                      <BookOpen className="w-3.5 h-3.5 text-cyan-400" />
                      <span>AGENT 3 REMEDIATION ADVICE</span>
                    </span>
                    <span className="text-[10px] text-neutral-500">{resolution.usedProvider}</span>
                  </div>

                  <div className="p-3.5 rounded-lg bg-[#0a0a0a] border border-white/[0.08] text-xs font-sans text-neutral-300 leading-relaxed">
                    {resolution.executiveSummary}
                  </div>

                  {resolution.recommendedWorkaround && (
                    <div className="p-3.5 rounded-lg bg-[#0a0a0a] border border-white/[0.08] space-y-2">
                      <span className="text-xs font-semibold text-white block">
                        Recommended Steps: {resolution.recommendedWorkaround.title}
                      </span>
                      <ol className="space-y-1.5 text-[11px] font-mono text-neutral-300 list-decimal list-inside">
                        {resolution.recommendedWorkaround.stepByStep.map((step, idx) => (
                          <li key={idx} className="leading-relaxed text-neutral-300">
                            {step}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {resolution.proposedCompliantSpec && (
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-[11px] font-mono text-neutral-400">
                        <span>COMPLIANT REPLACEMENT SPEC</span>
                        <button
                          onClick={() => handleCopyCode(resolution.proposedCompliantSpec)}
                          className="flex items-center space-x-1 text-[10px] text-amber-400 hover:text-amber-300"
                        >
                          {copiedCode ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                          <span>{copiedCode ? 'Copied' : 'Copy Spec'}</span>
                        </button>
                      </div>

                      <pre className="p-3 rounded-lg bg-black border border-white/[0.08] text-amber-300 text-[11px] font-mono overflow-x-auto leading-relaxed">
                        {resolution.proposedCompliantSpec}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
            )}
          </div>
        )}

        {/* ------------------------------------------------------------- */}
        {/* TAB 3: CYPHER & AGENT HANDOFF TRACE                           */}
        {/* ------------------------------------------------------------- */}
        {activeTab === 'cypher' && (
          <div className="space-y-3.5">
            <div className="flex items-center justify-between text-xs font-mono text-neutral-400">
              <span className="flex items-center space-x-1.5 text-cyan-400 font-semibold">
                <Terminal className="w-3.5 h-3.5 text-cyan-400" />
                <span>3-AGENT STATE TRANSITIONS & CYPHER</span>
              </span>
              <span className="text-[10px] text-neutral-500">Shared FalkorDB State</span>
            </div>

            {agentTraces.length === 0 ? (
              <div className="text-center py-16 text-neutral-500 text-xs font-mono">
                No active agent traces available. Execute an audit to inspect Cypher traversals.
              </div>
            ) : (
              <>
                {/* Latency Split Metric Card */}
                <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                  <div className="p-2.5 rounded-lg bg-neutral-900/60 border border-amber-500/30 flex items-center justify-between shadow-[0_0_10px_rgba(245,158,11,0.08)]">
                    <span className="text-neutral-400">⚡ FalkorDB Cypher:</span>
                    <span className="text-emerald-400 font-bold">
                      {agentTraces.find((t) => t.agent === 'AuditorAgent')?.durationMs || agentTraces[1]?.durationMs || 2}ms
                    </span>
                  </div>
                  <div className="p-2.5 rounded-lg bg-neutral-900/60 border border-blue-500/30 flex items-center justify-between shadow-[0_0_10px_rgba(59,130,246,0.08)]">
                    <span className="text-neutral-400">🧠 LLM Advisor:</span>
                    <span className="text-blue-300 font-bold">
                      {(((agentTraces.find((t) => t.agent === 'AdvisorAgent')?.durationMs || agentTraces[2]?.durationMs || 0)) / 1000).toFixed(1)}s
                    </span>
                  </div>
                </div>

                <div className={isReportMode ? 'grid grid-cols-3 gap-3' : 'space-y-3'}>
                {agentTraces.map((trace, idx) => (
                  <div
                    key={idx}
                    className="p-3.5 rounded-xl bg-[#0a0a0a] border border-white/[0.08] space-y-2.5 font-mono text-xs"
                  >
                    <div className="flex items-center justify-between border-b border-white/[0.06] pb-2">
                      <span className="font-bold text-white flex items-center space-x-1.5">
                        <Cpu className="w-3.5 h-3.5 text-cyan-400" />
                        <span>{trace.agent}</span>
                      </span>
                      <span className="text-[10px] text-neutral-400">{trace.durationMs}ms</span>
                    </div>

                    <div className="flex items-center space-x-2 text-[11px]">
                      <span className="text-neutral-500">Handoff:</span>
                      <span className="px-1.5 py-0.5 rounded bg-neutral-900 border border-white/[0.06] text-amber-400">
                        {trace.stateTransition.from}
                      </span>
                      <ArrowRight className="w-3 h-3 text-neutral-600" />
                      <span className="px-1.5 py-0.5 rounded bg-neutral-900 border border-white/[0.06] text-emerald-400 font-bold">
                        {trace.stateTransition.to}
                      </span>
                    </div>

                    <p className="text-[11px] text-neutral-300 font-sans leading-relaxed">
                      {trace.summary}
                    </p>

                    {trace.cypherQueries && trace.cypherQueries.length > 0 && (
                      <div className="space-y-1">
                        <span className="text-[9px] uppercase text-neutral-500 font-semibold block">
                          Cypher Multi-Hop Traversal
                        </span>
                        {trace.cypherQueries.map((q, qIdx) => (
                          <div
                            key={qIdx}
                            className="p-2 rounded bg-black border border-white/[0.04] text-[10px] text-cyan-300 overflow-x-auto leading-relaxed"
                          >
                            {q}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
