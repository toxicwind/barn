import React, { useEffect, useState } from 'react';
import { Terminal, Activity, CheckCircle2, AlertTriangle, Cpu } from 'lucide-react';
import { AgentTrace } from '../types';

interface AgentVoiceBarProps {
  isAuditing: boolean;
  activeStep: 'idle' | 'extractor' | 'auditor' | 'advisor' | 'complete' | 'error';
  lastProposalTitle?: string;
  violationsCount?: number;
  blastRadiusCount?: number;
  episodesCount?: number;
  agentTraces?: AgentTrace[];
  adrCount?: number;
}

export const AgentVoiceBar: React.FC<AgentVoiceBarProps> = ({
  isAuditing,
  activeStep,
  lastProposalTitle,
  violationsCount = 0,
  blastRadiusCount = 0,
  episodesCount = 0,
  agentTraces = [],
  adrCount = 5,
}) => {
  const [displayedText, setDisplayedText] = useState<string>('');
  const [targetMessage, setTargetMessage] = useState<string>('');

  useEffect(() => {
    let msg = `Company Brain online. Grounded by ${adrCount} Architecture Decision Records in FalkorDB. Select a PR preset to audit.`;

    if (activeStep === 'extractor') {
      msg = '⚡ [ExtractorAgent] Reading FalkorDB graph catalog... Parsing diff parameters into structured target entity (:Proposal)...';
    } else if (activeStep === 'auditor') {
      msg = '🔍 [AuditorAgent] Traversal initiated. Executing multi-hop Cypher queries to verify ADR constraints and trace consumer blast radius...';
    } else if (activeStep === 'advisor') {
      msg = '🧠 [AdvisorAgent] Inspecting FalkorDB :Proposal subgraph. Recalling past architectural episode compromises from memory...';
    } else if (activeStep === 'complete') {
      if (violationsCount > 0) {
        msg = `🚨 [Audit Complete] Flagged ${violationsCount} ADR policy violation(s) impacting ${blastRadiusCount} downstream service(s). Recalled ${episodesCount} historic workaround(s) from FalkorDB.`;
      } else {
        msg = '✅ [Audit Complete] Zero ADR violations detected. Proposal strictly conforms to company architectural invariants.';
      }
    } else if (activeStep === 'error') {
      msg = '❌ Audit failed. Check backend connection on port 4000 or inspect server logs.';
    }

    setTargetMessage(msg);
  }, [activeStep, violationsCount, blastRadiusCount, episodesCount, lastProposalTitle]);

  // Typewriter effect
  useEffect(() => {
    let index = 0;
    setDisplayedText('');

    const interval = setInterval(() => {
      index++;
      setDisplayedText(targetMessage.slice(0, index));
      if (index >= targetMessage.length) {
        clearInterval(interval);
      }
    }, 15);

    return () => clearInterval(interval);
  }, [targetMessage]);

  return (
    <div className="h-9 border-b border-white/[0.06] bg-[#070707] px-4 flex items-center justify-between text-xs font-mono select-none overflow-hidden">
      <div className="flex items-center space-x-2.5 truncate max-w-[85%]">
        <div className="flex items-center space-x-1.5 flex-shrink-0">
          {isAuditing ? (
            <Activity className="w-3.5 h-3.5 text-amber-400 animate-spin" />
          ) : activeStep === 'complete' && violationsCount > 0 ? (
            <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
          ) : activeStep === 'complete' ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          ) : (
            <Terminal className="w-3.5 h-3.5 text-neutral-500" />
          )}
          <span className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wider">
            AGENT TELEMETRY:
          </span>
        </div>

        <p className="text-neutral-200 truncate font-mono text-[11px]">
          {displayedText}
          <span className="animate-pulse text-amber-400 font-bold ml-0.5">_</span>
        </p>
      </div>

      {/* Latency & State Badge */}
      <div className="hidden lg:flex items-center space-x-3 text-[11px] text-neutral-400 font-mono flex-shrink-0">
        {agentTraces.length > 0 && (
          <div className="flex items-center space-x-2 text-[11px]">
            <span className="px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/20 font-bold">
              ⚡ FalkorDB Graph: {agentTraces.find((t) => t.agent === 'AuditorAgent')?.durationMs || agentTraces[1]?.durationMs || 2}ms
            </span>
            <span className="text-neutral-600">|</span>
            <span className="px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20">
              🧠 LLM Advisor: {(((agentTraces.find((t) => t.agent === 'AdvisorAgent')?.durationMs || agentTraces[2]?.durationMs || 0)) / 1000).toFixed(1)}s
            </span>
          </div>
        )}
        <div className="flex items-center space-x-1.5 pl-2 border-l border-white/[0.08]">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
          <span className="text-emerald-400">REALTIME GRAPH</span>
        </div>
      </div>
    </div>
  );
};
