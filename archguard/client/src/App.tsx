import React, { useState, useEffect } from 'react';
import { LandingPage } from './components/LandingPage';
import { Header } from './components/Header';
import { AgentVoiceBar } from './components/AgentVoiceBar';
import { ProposalInputPane } from './components/ProposalInputPane';
import { GraphCanvas, ViewMode } from './components/GraphCanvas';
import { AuditResultsPane } from './components/AuditResultsPane';
import { IngestAdrModal } from './components/IngestAdrModal';
import { RecordMemoryModal } from './components/RecordMemoryModal';
import { ApiKeysModal } from './components/ApiKeysModal';
import {
  fetchHealth,
  fetchGraph,
  fetchPresets,
  executeAudit,
  resetGraph,
} from './api';
import {
  GraphNode,
  GraphLink,
  PresetItem,
  FullAuditPayload,
  GraphPath,
} from './types';

export const App: React.FC = () => {
  // Navigation View State: 'landing' vs 'app'
  const [view, setView] = useState<'landing' | 'app'>('landing');

  // Graph State
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [links, setLinks] = useState<GraphLink[]>([]);
  const [graphStats, setGraphStats] = useState<{ totalNodes: number; totalEdges: number } | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [highlightedPath, setHighlightedPath] = useState<GraphPath | null>(null);

  // Preset & Editor State
  const [presets, setPresets] = useState<PresetItem[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [rawInput, setRawInput] = useState<string>('');
  const [proposalTitle, setProposalTitle] = useState<string>('');

  // Audit Execution State
  const [isAuditing, setIsAuditing] = useState<boolean>(false);
  const [activeStep, setActiveStep] = useState<
    'idle' | 'extractor' | 'auditor' | 'advisor' | 'complete' | 'error'
  >('idle');
  const [auditPayload, setAuditPayload] = useState<FullAuditPayload | null>(null);

  // Responsive Layout / View Mode State
  const [viewMode, setViewMode] = useState<ViewMode>('split');
  const [isLeftCollapsed, setIsLeftCollapsed] = useState<boolean>(false);

  // Modals
  const [isIngestAdrOpen, setIsIngestAdrOpen] = useState(false);
  const [isRecordMemoryOpen, setIsRecordMemoryOpen] = useState(false);
  const [isApiKeysOpen, setIsApiKeysOpen] = useState(false);

  // Runtime API Keys
  const [runtimeKey, setRuntimeKey] = useState<string>('');
  const [runtimeProvider, setRuntimeProvider] = useState<'openrouter' | 'gemini'>('openrouter');

  // Load Initial Graph, Health & Presets
  const loadInitialData = async () => {
    try {
      const [healthData, graphData, presetsData] = await Promise.all([
        fetchHealth().catch(() => null),
        fetchGraph().catch(() => ({ nodes: [], links: [], stats: { totalNodes: 0, totalEdges: 0 } })),
        fetchPresets().catch(() => []),
      ]);

      if (healthData?.graphStats) {
        setGraphStats(healthData.graphStats);
      }

      if (graphData?.nodes) {
        setNodes(graphData.nodes);
        setLinks(graphData.links);
        setGraphStats(graphData.stats);
      }

      if (presetsData?.length > 0) {
        setPresets(presetsData);
        // Default to first preset (PR-409)
        const first = presetsData[0];
        setSelectedPresetId(first.id);
        setRawInput(first.rawInput);
        setProposalTitle(first.title);
      }
    } catch (err) {
      console.error('Failed to load initial data:', err);
    }
  };

  useEffect(() => {
    loadInitialData();
  }, []);

  const handleSelectPreset = (preset: PresetItem) => {
    setSelectedPresetId(preset.id);
    setRawInput(preset.rawInput);
    setProposalTitle(preset.title);
    setHighlightedPath(null);
    setAuditPayload(null);
    setActiveStep('idle');
  };

  const handleExecuteAudit = async () => {
    if (!rawInput.trim() || isAuditing) return;

    setIsAuditing(true);
    setActiveStep('extractor');
    setAuditPayload(null);
    setHighlightedPath(null);

    // Realistic agent telemetry sequence
    const stepTimer1 = setTimeout(() => setActiveStep('auditor'), 1100);
    const stepTimer2 = setTimeout(() => setActiveStep('advisor'), 2300);

    try {
      const payload = await executeAudit(rawInput, proposalTitle, {
        apiKey: runtimeKey || undefined,
        provider: runtimeProvider,
      });

      clearTimeout(stepTimer1);
      clearTimeout(stepTimer2);

      setAuditPayload(payload);
      if (payload.proposal?.title) {
        setProposalTitle(payload.proposal.title);
      }
      setHighlightedPath(payload.highlightedPath);

      if (payload.graphTopology?.nodes) {
        setNodes(payload.graphTopology.nodes);
        setLinks(payload.graphTopology.links);
        setGraphStats(payload.graphTopology.stats);
      }

      setActiveStep('complete');
    } catch (err) {
      clearTimeout(stepTimer1);
      clearTimeout(stepTimer2);
      console.error('Audit failed:', err);
      setActiveStep('error');
    } finally {
      setIsAuditing(false);
    }
  };

  const handleResetGraph = async () => {
    if (isAuditing) return;
    try {
      await resetGraph();
      await loadInitialData();
      setAuditPayload(null);
      setHighlightedPath(null);
      setActiveStep('idle');
    } catch (err) {
      console.error('Failed to reset graph:', err);
    }
  };

  // Determine dynamic column widths based on ViewMode
  const getPaneWidths = () => {
    if (viewMode === 'canvas') {
      return {
        left: 'w-12', // collapsed
        canvas: 'flex-1',
        right: 'w-[360px] xl:w-[400px]',
      };
    }
    if (viewMode === 'report') {
      return {
        left: 'w-12', // collapsed
        canvas: 'w-[360px] xl:w-[420px]',
        right: 'flex-1', // takes full remaining width!
      };
    }
    // 'split' (balanced)
    return {
      left: isLeftCollapsed ? 'w-12' : 'w-[320px] xl:w-[360px]',
      canvas: 'flex-1',
      right: 'w-[380px] xl:w-[440px]',
    };
  };

  const widths = getPaneWidths();

  if (view === 'landing') {
    return <LandingPage onLaunch={() => setView('app')} stats={graphStats} />;
  }

  return (
    <div className="flex flex-col h-screen w-screen bg-[#000000] text-neutral-100 overflow-hidden font-sans">
      {/* 1. Header */}
      <Header
        stats={graphStats}
        graphName="archguard_brain"
        isAuditing={isAuditing}
        onOpenIngestAdr={() => setIsIngestAdrOpen(true)}
        onOpenRecordMemory={() => setIsRecordMemoryOpen(true)}
        onOpenApiKeys={() => setIsApiKeysOpen(true)}
        onResetGraph={handleResetGraph}
        onBackToLanding={() => setView('landing')}
      />

      {/* 2. Interactive Conversational Telemetry Bar */}
      <AgentVoiceBar
        isAuditing={isAuditing}
        activeStep={activeStep}
        lastProposalTitle={proposalTitle}
        violationsCount={auditPayload?.violations?.length || 0}
        blastRadiusCount={auditPayload?.blastRadius?.length || 0}
        episodesCount={auditPayload?.episodicMemory?.length || 0}
        agentTraces={auditPayload?.agentTraces || []}
        adrCount={nodes.filter((n) => n.label === 'ADR').length || 5}
      />

      {/* 3. Main 3-Pane Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Pane: Spec Input & Presets */}
        <div className={`${widths.left} h-full flex-shrink-0 transition-all duration-300`}>
          <ProposalInputPane
            presets={presets}
            selectedPresetId={selectedPresetId}
            rawInput={rawInput}
            onSelectPreset={handleSelectPreset}
            onChangeRawInput={(val) => {
              setRawInput(val);
              const currentPreset = presets.find((p) => p.id === selectedPresetId);
              if (currentPreset && val.trim() !== currentPreset.rawInput.trim()) {
                setSelectedPresetId(null);
                setProposalTitle('');
              }
            }}
            onExecuteAudit={handleExecuteAudit}
            isAuditing={isAuditing}
            isCollapsed={viewMode !== 'split' || isLeftCollapsed}
            onToggleCollapse={() => {
              if (viewMode !== 'split') {
                setViewMode('split');
                setIsLeftCollapsed(false);
              } else {
                setIsLeftCollapsed(!isLeftCollapsed);
              }
            }}
          />
        </div>

        {/* Center Pane: Pitch-Black Constellation Graph */}
        <div className={`${widths.canvas} h-full min-w-0 transition-all duration-300`}>
          <GraphCanvas
            nodes={nodes}
            links={links}
            highlightedPath={highlightedPath}
            selectedNode={selectedNode}
            onSelectNode={setSelectedNode}
            activeProposalId={auditPayload?.proposalId}
            viewMode={viewMode}
            onChangeViewMode={setViewMode}
          />
        </div>

        {/* Right Pane: Intelligence, Memory & Cypher Trace */}
        <div className={`${widths.right} h-full flex-shrink-0 transition-all duration-300`}>
          <AuditResultsPane
            proposalId={auditPayload?.proposalId || null}
            status={auditPayload?.status || null}
            violations={auditPayload?.violations || []}
            blastRadius={auditPayload?.blastRadius || []}
            episodicMemory={auditPayload?.episodicMemory || []}
            resolution={auditPayload?.resolution || null}
            agentTraces={auditPayload?.agentTraces || []}
            onOpenRecordMemory={() => setIsRecordMemoryOpen(true)}
            viewMode={viewMode}
          />
        </div>
      </div>

      {/* Modals */}
      <IngestAdrModal
        isOpen={isIngestAdrOpen}
        onClose={() => setIsIngestAdrOpen(false)}
        onSuccess={loadInitialData}
      />

      <RecordMemoryModal
        isOpen={isRecordMemoryOpen}
        onClose={() => setIsRecordMemoryOpen(false)}
        onSuccess={loadInitialData}
        defaultAdrCode={auditPayload?.violations?.[0]?.adrCode || 'ADR-001'}
      />

      <ApiKeysModal
        isOpen={isApiKeysOpen}
        onClose={() => setIsApiKeysOpen(false)}
        runtimeKey={runtimeKey}
        runtimeProvider={runtimeProvider}
        onSave={(k, p) => {
          setRuntimeKey(k);
          setRuntimeProvider(p);
        }}
      />
    </div>
  );
};
