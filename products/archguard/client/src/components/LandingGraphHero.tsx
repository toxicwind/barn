import React, { useState, useEffect } from 'react';

interface HeroNode {
  id: string;
  label: string;
  sublabel: string;
  type: 'proposal' | 'field' | 'adr' | 'service' | 'episode' | 'team';
  x: number;
  y: number;
  color: string;
  glow: string;
}

interface HeroEdge {
  from: string;
  to: string;
  label: string;
  type: 'conflict' | 'normal' | 'precedent';
  color: string;
  dashed?: boolean;
}

const HERO_NODES: HeroNode[] = [
  {
    id: 'ADR-001',
    label: 'ADR-001',
    sublabel: 'Mandate UUIDv4',
    type: 'adr',
    x: 260,
    y: 80,
    color: '#F59E0B',
    glow: 'rgba(245, 158, 11, 0.4)',
  },
  {
    id: 'INC-2023-42',
    label: 'INC-2023-42',
    sublabel: 'Shadow Dual-Write',
    type: 'episode',
    x: 430,
    y: 110,
    color: '#10B981',
    glow: 'rgba(16, 185, 129, 0.4)',
  },
  {
    id: 'Identity-Core',
    label: 'Identity-Core',
    sublabel: 'Team • @alex_lead',
    type: 'team',
    x: 90,
    y: 130,
    color: '#34D399',
    glow: 'rgba(52, 211, 153, 0.3)',
  },
  {
    id: 'user_id',
    label: 'user_id',
    sublabel: 'SchemaField',
    type: 'field',
    x: 200,
    y: 240,
    color: '#FBBF24',
    glow: 'rgba(251, 191, 36, 0.4)',
  },
  {
    id: 'auth-service',
    label: 'auth-service',
    sublabel: 'Producer Service',
    type: 'service',
    x: 350,
    y: 230,
    color: '#06B6D4',
    glow: 'rgba(6, 182, 212, 0.4)',
  },
  {
    id: 'billing-service',
    label: 'billing-service',
    sublabel: 'Downstream Consumer',
    type: 'service',
    x: 430,
    y: 340,
    color: '#3B82F6',
    glow: 'rgba(59, 130, 246, 0.4)',
  },
  {
    id: 'PR-409',
    label: 'PR-409',
    sublabel: 'Proposed int64',
    type: 'proposal',
    x: 90,
    y: 350,
    color: '#F43F5E',
    glow: 'rgba(244, 63, 94, 0.5)',
  },
];

const HERO_EDGES: HeroEdge[] = [
  { from: 'PR-409', to: 'user_id', label: '[:TARGETS]', type: 'conflict', color: '#F43F5E', dashed: true },
  { from: 'user_id', to: 'ADR-001', label: '[:VIOLATES]', type: 'conflict', color: '#F43F5E', dashed: true },
  { from: 'user_id', to: 'auth-service', label: '[:DEFINED_IN]', type: 'normal', color: '#06B6D4' },
  { from: 'auth-service', to: 'billing-service', label: '[:BREAKS_CONSUMER]', type: 'conflict', color: '#F43F5E', dashed: true },
  { from: 'INC-2023-42', to: 'ADR-001', label: '[:APPLIES_TO]', type: 'precedent', color: '#10B981', dashed: true },
  { from: 'Identity-Core', to: 'ADR-001', label: '[:OWNS]', type: 'normal', color: '#34D399' },
  { from: 'Identity-Core', to: 'auth-service', label: '[:MANAGES]', type: 'normal', color: '#34D399' },
];

export const LandingGraphHero: React.FC = () => {
  const [hoveredNode, setHoveredNode] = useState<HeroNode | null>(null);
  const [activeMode, setActiveMode] = useState<'collision' | 'memory'>('collision');
  const [pulseTick, setPulseTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setPulseTick((t) => (t + 1) % 100);
    }, 1200);
    return () => clearInterval(timer);
  }, []);

  const getNode = (id: string) => HERO_NODES.find((n) => n.id === id);

  return (
    <div className="relative w-full max-w-lg lg:max-w-xl mx-auto">
      {/* Ambient background glow */}
      <div className="absolute -inset-1 bg-gradient-to-r from-amber-500/20 via-rose-500/10 to-cyan-500/20 rounded-2xl blur-2xl opacity-50 group-hover:opacity-75 transition duration-1000 -z-10" />

      {/* Main Glass Widget Box */}
      <div className="relative rounded-2xl bg-[#080808]/90 border border-white/[0.12] shadow-2xl overflow-hidden backdrop-blur-2xl">
        {/* Top Widget Telemetry Bar */}
        <div className="px-4 py-3 border-b border-white/[0.08] bg-[#0c0c0c]/80 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <span className="text-xs font-mono font-medium text-neutral-300">
              FalkorDB In-Memory Graph
            </span>
          </div>

          {/* Mode Switcher Tabs */}
          <div className="flex items-center bg-black/60 p-0.5 rounded-lg border border-white/[0.08] text-[11px] font-mono">
            <button
              onClick={() => setActiveMode('collision')}
              className={`px-2.5 py-1 rounded-md transition-all flex items-center gap-1.5 ${
                activeMode === 'collision'
                  ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${activeMode === 'collision' ? 'bg-rose-400 animate-pulse' : 'bg-neutral-600'}`} />
              COLLISION
            </button>
            <button
              onClick={() => setActiveMode('memory')}
              className={`px-2.5 py-1 rounded-md transition-all flex items-center gap-1.5 ${
                activeMode === 'memory'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'text-neutral-400 hover:text-white'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${activeMode === 'memory' ? 'bg-emerald-400 animate-pulse' : 'bg-neutral-600'}`} />
              MEMORY
            </button>
          </div>
        </div>

        {/* SVG Graph Interactive Canvas */}
        <div className="relative h-[380px] w-full bg-[#030303] flex items-center justify-center select-none overflow-hidden">
          {/* Subtle grid background */}
          <div className="absolute inset-0 bg-[radial-gradient(#ffffff0a_1px,transparent_1px)] [background-size:16px_16px]" />

          <svg
            className="w-full h-full"
            viewBox="0 0 520 420"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <filter id="hero-glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="6" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>

              <filter id="laser-glow" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Edges */}
            {HERO_EDGES.map((edge, idx) => {
              const fromNode = getNode(edge.from);
              const toNode = getNode(edge.to);
              if (!fromNode || !toNode) return null;

              const isConflict = edge.type === 'conflict';
              const isPrecedent = edge.type === 'precedent';
              const isHighlighted =
                (activeMode === 'collision' && isConflict) ||
                (activeMode === 'memory' && isPrecedent);

              return (
                <g key={`edge-${idx}`}>
                  {/* Base Line */}
                  <line
                    x1={fromNode.x}
                    y1={fromNode.y}
                    x2={toNode.x}
                    y2={toNode.y}
                    stroke={isHighlighted ? edge.color : 'rgba(255, 255, 255, 0.12)'}
                    strokeWidth={isHighlighted ? 2.2 : 1}
                    strokeDasharray={edge.dashed ? '5,4' : undefined}
                    filter={isHighlighted ? 'url(#laser-glow)' : undefined}
                    className={isHighlighted ? 'animate-laser-flow' : ''}
                  />

                  {/* Flowing Laser Beam Data Packet when Highlighted */}
                  {isHighlighted && (
                    <circle r="3.5" fill={edge.color} filter="url(#laser-glow)">
                      <animateMotion
                        dur="1.8s"
                        repeatCount="indefinite"
                        path={`M ${fromNode.x} ${fromNode.y} L ${toNode.x} ${toNode.y}`}
                      />
                    </circle>
                  )}
                </g>
              );
            })}

            {/* Nodes */}
            {HERO_NODES.map((node) => {
              const isHovered = hoveredNode?.id === node.id;
              const isSpecial =
                (activeMode === 'collision' && (node.type === 'proposal' || node.type === 'adr')) ||
                (activeMode === 'memory' && (node.type === 'episode' || node.type === 'adr'));

              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x}, ${node.y})`}
                  className="cursor-pointer group"
                  onMouseEnter={() => setHoveredNode(node)}
                  onMouseLeave={() => setHoveredNode(null)}
                >
                  {/* Glowing Outer Ripple */}
                  {isSpecial && (
                    <circle
                      r="26"
                      fill="none"
                      stroke={node.color}
                      strokeWidth="1"
                      strokeOpacity="0.4"
                      className="animate-ping"
                      style={{ animationDuration: '3s' }}
                    />
                  )}

                  {/* Outer Ring */}
                  <circle
                    r={isHovered ? 20 : 16}
                    fill="#050505"
                    stroke={node.color}
                    strokeWidth={isHovered ? 2.5 : 1.8}
                    filter="url(#hero-glow)"
                    className="transition-all duration-200"
                  />

                  {/* Inner Core */}
                  <circle
                    r={isHovered ? 7 : 5}
                    fill={node.color}
                    className="transition-all duration-200"
                  />

                  {/* Label */}
                  <text
                    y={28}
                    textAnchor="middle"
                    fill={isHovered ? '#FFFFFF' : '#D1D5DB'}
                    fontSize="11"
                    fontFamily="monospace"
                    fontWeight={isHovered ? '700' : '500'}
                    className="pointer-events-none select-none transition-colors"
                  >
                    {node.label}
                  </text>

                  {/* Sublabel */}
                  <text
                    y={40}
                    textAnchor="middle"
                    fill="#9CA3AF"
                    fontSize="9"
                    fontFamily="sans-serif"
                    className="pointer-events-none select-none"
                  >
                    {node.sublabel}
                  </text>
                </g>
              );
            })}
          </svg>

          {/* Hover Floating Peek Inspector */}
          {hoveredNode && (
            <div className="absolute bottom-3 left-4 right-4 bg-black/90 border border-white/[0.15] backdrop-blur-md rounded-xl p-2.5 flex items-center justify-between text-xs animate-in fade-in duration-150">
              <div className="flex items-center space-x-2">
                <div
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: hoveredNode.color }}
                />
                <span className="font-mono font-bold text-white">{hoveredNode.label}</span>
                <span className="text-neutral-400 font-mono text-[10px]">({hoveredNode.type})</span>
                <span className="text-neutral-500">•</span>
                <span className="text-neutral-300">{hoveredNode.sublabel}</span>
              </div>
              <span className="text-[10px] text-amber-400 font-mono">FalkorDB Node</span>
            </div>
          )}
        </div>

        {/* Bottom Status Ticker */}
        <div className="px-4 py-2.5 bg-[#0a0a0a] border-t border-white/[0.08] flex items-center justify-between text-[11px] font-mono text-neutral-400">
          <div className="flex items-center gap-2 text-neutral-300">
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-bold">
              CYPHER
            </span>
            <span className="text-neutral-400">Traversal Latency:</span>
            <span className="text-emerald-400 font-semibold font-mono">0.8ms</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-neutral-500">Multi-Hop Traversal</span>
            <span className="text-white/20">|</span>
            <span className="text-cyan-400">Deterministic Cypher</span>
          </div>
        </div>
      </div>
    </div>
  );
};
