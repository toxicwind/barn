import React, { useState, useRef, useMemo } from 'react';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  X,
  Shield,
  Layers,
  Activity,
  Server,
  Users,
  Brain,
  FileCheck2,
  Columns,
  Eye,
  BookOpen,
} from 'lucide-react';
import { GraphNode, GraphLink, GraphPath } from '../types';

export type ViewMode = 'split' | 'canvas' | 'report';

interface GraphCanvasProps {
  nodes: GraphNode[];
  links: GraphLink[];
  highlightedPath: GraphPath | null;
  selectedNode: GraphNode | null;
  onSelectNode: (node: GraphNode | null) => void;
  activeProposalId?: string | null;
  viewMode: ViewMode;
  onChangeViewMode: (mode: ViewMode) => void;
}

export const GraphCanvas: React.FC<GraphCanvasProps> = ({
  nodes,
  links,
  highlightedPath,
  selectedNode,
  onSelectNode,
  activeProposalId,
  viewMode,
  onChangeViewMode,
}) => {
  // Pan & Zoom transform state: responsive auto-scale based on viewMode
  const [transform, setTransform] = useState<{ x: number; y: number; k: number }>({
    x: 10,
    y: viewMode === 'canvas' ? 45 : 65,
    k: viewMode === 'canvas' ? 0.84 : 0.51,
  });

  // Responsive auto-fit: adapt zoom scale when switching between Split View and Canvas Focus
  React.useEffect(() => {
    if (viewMode === 'canvas') {
      setTransform({ x: 30, y: 45, k: 0.84 });
    } else {
      setTransform({ x: 10, y: 65, k: 0.51 });
    }
  }, [viewMode]);

  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isolateCollision, setIsolateCollision] = useState<boolean>(false);
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);

  // Filter nodes: Only show currently active Proposal node (hide older PRs)
  const filteredNodes = useMemo(() => {
    return nodes.filter((n) => {
      if (n.label !== 'Proposal') return true;
      if (!activeProposalId) return true;
      const prId = n.properties?.id || n.name;
      return prId === activeProposalId || prId.includes(activeProposalId);
    });
  }, [nodes, activeProposalId]);

  // Compute deterministic coordinates in 4 structured constellation tiers
  const layoutNodes = useMemo(() => {
    const width = 1250;

    const tier1: GraphNode[] = []; // ADR & ArchitecturalEpisode (Top)
    const tier2: GraphNode[] = []; // Team & Person
    const tier3: GraphNode[] = []; // Service & Endpoint
    const tier4: GraphNode[] = []; // SchemaField & Active Proposal (Bottom)
    const other: GraphNode[] = [];

    filteredNodes.forEach((n) => {
      const lbl = n.label;
      if (lbl === 'ADR' || lbl === 'ArchitecturalEpisode') tier1.push(n);
      else if (lbl === 'Team' || lbl === 'Person') tier2.push(n);
      else if (lbl === 'Service' || lbl === 'Endpoint') tier3.push(n);
      else if (lbl === 'SchemaField' || lbl === 'Proposal') tier4.push(n);
      else other.push(n);
    });

    const assignPositions = (group: GraphNode[], yBase: number) => {
      const count = group.length;
      if (count === 0) return [];
      const margin = 90;
      const step = count > 1 ? (width - margin * 2) / (count - 1) : 0;
      return group.map((n, i) => ({
        ...n,
        x: count === 1 ? width / 2 : margin + i * step,
        y: yBase + (i % 2 === 1 ? 28 : -18), // organic alternating stagger to eliminate overlap
      }));
    };

    return [
      ...assignPositions(tier1, 95),
      ...assignPositions(tier2, 260),
      ...assignPositions(tier3, 430),
      ...assignPositions(tier4, 600),
      ...assignPositions(other, 700),
    ];
  }, [filteredNodes]);

  // Node position lookup map
  const nodeMap = useMemo(() => {
    const map = new Map<string | number, GraphNode>();
    layoutNodes.forEach((n) => {
      map.set(n.id, n);
    });
    return map;
  }, [layoutNodes]);

  // Highlighted IDs set
  const highlightedNodeIds = useMemo(() => {
    const set = new Set<string | number>();
    if (highlightedPath && highlightedPath.nodes) {
      highlightedPath.nodes.forEach((n) => set.add(n.nodeId));
    }
    return set;
  }, [highlightedPath]);

  // Auto-isolate collision path as default view once an audit finishes
  React.useEffect(() => {
    if (highlightedPath && highlightedPath.nodes && highlightedPath.nodes.length > 0) {
      setIsolateCollision(true);
    }
  }, [highlightedPath]);

  // Short badge helper: under circle, render ONLY max 16 chars!
  const getNodeShortCode = (node: GraphNode): string => {
    const props = node.properties || {};
    if (node.label === 'ADR') {
      return props.code || props.id || node.name.match(/ADR-\d+/i)?.[0] || 'ADR';
    }
    if (node.label === 'ArchitecturalEpisode') {
      return props.incident_id || props.code || 'INC-EP';
    }
    if (node.label === 'Proposal') {
      const prMatch = (props.title || node.name || props.id || '').match(/PR\s*#?([0-9]+)/i);
      return prMatch ? `PR-${prMatch[1]}` : (props.id || 'Proposal');
    }
    if (node.label === 'Endpoint') {
      const p = props.path || node.name;
      return p.length > 16 ? p.slice(0, 15) + '…' : p;
    }
    if (node.label === 'Person') {
      return props.handle ? `@${props.handle}` : node.name.slice(0, 14);
    }
    const name = props.name || node.name;
    return name.length > 15 ? name.slice(0, 14) + '…' : name;
  };

  // Node visual styles
  const getNodeVisual = (label: string, isViolated: boolean, status?: string) => {
    if (label === 'Proposal') {
      const isApproved = status === 'RESOLVED' || status === 'APPROVED';
      if (isApproved) {
        return {
          fill: '#10B981',
          stroke: '#34D399',
          filter: 'url(#glow-emerald)',
          labelColor: 'text-emerald-400',
          badgeBg: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
        };
      }
      return {
        fill: '#F43F5E',
        stroke: '#FB7185',
        filter: 'url(#glow-crimson)',
        labelColor: 'text-rose-400',
        badgeBg: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
      };
    }
    if (label === 'ADR') {
      return {
        fill: isViolated ? '#F43F5E' : '#F59E0B',
        stroke: isViolated ? '#FB7185' : '#FBBF24',
        filter: isViolated ? 'url(#glow-crimson)' : 'url(#glow-gold)',
        labelColor: isViolated ? 'text-rose-400' : 'text-amber-400',
        badgeBg: isViolated ? 'bg-rose-500/20 text-rose-300' : 'bg-amber-500/20 text-amber-300',
      };
    }
    if (label === 'ArchitecturalEpisode') {
      return {
        fill: '#10B981',
        stroke: '#34D399',
        filter: 'url(#glow-emerald)',
        labelColor: 'text-emerald-400',
        badgeBg: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
      };
    }
    if (label === 'Team' || label === 'Person') {
      return {
        fill: '#10B981',
        stroke: '#34D399',
        filter: 'url(#glow-emerald)',
        labelColor: 'text-emerald-400',
        badgeBg: 'bg-emerald-500/10 text-emerald-300',
      };
    }
    if (label === 'Service') {
      return {
        fill: '#3B82F6',
        stroke: '#60A5FA',
        filter: 'url(#glow-blue)',
        labelColor: 'text-blue-400',
        badgeBg: 'bg-blue-500/20 text-blue-300',
      };
    }
    if (label === 'Endpoint') {
      return {
        fill: '#06B6D4',
        stroke: '#22D3EE',
        filter: 'url(#glow-cyan)',
        labelColor: 'text-cyan-400',
        badgeBg: 'bg-cyan-500/20 text-cyan-300',
      };
    }
    // SchemaField
    return {
      fill: isViolated ? '#F43F5E' : '#F59E0B',
      stroke: isViolated ? '#FB7185' : '#FBBF24',
      filter: isViolated ? 'url(#glow-crimson)' : 'url(#glow-gold)',
      labelColor: isViolated ? 'text-rose-400' : 'text-amber-400',
      badgeBg: 'bg-amber-500/20 text-amber-300',
    };
  };

  // Drag / Pan Handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - transform.x, y: e.clientY - transform.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      setTransform((prev) => ({
        ...prev,
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      }));
    }
  };

  const handleMouseUp = () => setIsDragging(false);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.08 : 0.92;
    const newK = Math.max(0.4, Math.min(2.5, transform.k * zoomFactor));
    setTransform((prev) => ({ ...prev, k: newK }));
  };

  const recenter = () => {
    if (viewMode === 'canvas') {
      setTransform({ x: 30, y: 45, k: 0.84 });
    } else {
      setTransform({ x: 10, y: 65, k: 0.51 });
    }
  };

  return (
    <div className="relative w-full h-full bg-[#000000] overflow-hidden select-none flex flex-col">
      {/* Radial Dot Pattern Canvas Backdrop */}
      <div className="absolute inset-0 bg-[radial-gradient(#ffffff14_1px,transparent_1px)] [background-size:24px_24px] pointer-events-none opacity-50" />

      {/* Ambient Top Glow Spotlights */}
      <div className="absolute top-0 left-1/4 w-96 h-96 bg-amber-500/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute top-1/3 right-1/4 w-96 h-96 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none" />

      {/* Top Header Controls Bar */}
      <div className="absolute top-3 left-4 right-4 z-20 flex items-center justify-between pointer-events-none">
        {/* Left: Collision Path Filter */}
        <div className="flex items-center space-x-2 pointer-events-auto">
          <button
            onClick={() => setIsolateCollision(false)}
            className={`text-[11px] font-mono px-3 py-1 rounded-full border transition-all ${
              !isolateCollision
                ? 'bg-neutral-900 text-white border-white/20 shadow-[0_0_12px_rgba(255,255,255,0.08)]'
                : 'bg-black/80 text-neutral-400 border-white/10 hover:text-white'
            }`}
          >
            All Constellation ({filteredNodes.length})
          </button>

          {highlightedPath && (
            <button
              onClick={() => setIsolateCollision(!isolateCollision)}
              className={`text-[11px] font-mono px-3 py-1 rounded-full border flex items-center space-x-1.5 transition-all ${
                isolateCollision
                  ? 'bg-rose-950/80 text-rose-300 border-rose-500/60 shadow-[0_0_15px_rgba(244,63,94,0.3)] animate-pulse'
                  : 'bg-black/80 text-rose-400 border-rose-500/30 hover:border-rose-500'
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-ping" />
              <span>{isolateCollision ? 'Show Full Graph' : 'Isolate Collision Path'}</span>
            </button>
          )}
        </div>

        {/* Right: View Mode Switcher + Zoom Controls */}
        <div className="flex items-center space-x-2 pointer-events-auto">
          {/* View Mode Switcher */}
          <div className="flex items-center bg-[#0a0a0a]/90 backdrop-blur-md border border-white/[0.08] rounded-lg p-0.5 text-xs font-mono">
            <button
              onClick={() => onChangeViewMode('split')}
              className={`flex items-center space-x-1 px-2.5 py-1 rounded-md transition-all ${
                viewMode === 'split'
                  ? 'bg-neutral-800 text-amber-300 font-semibold shadow-[0_0_10px_rgba(245,158,11,0.2)]'
                  : 'text-neutral-400 hover:text-white'
              }`}
              title="Split View: Balanced 3-column layout"
            >
              <Columns className="w-3 h-3" />
              <span className="hidden sm:inline">Split</span>
            </button>

            <button
              onClick={() => onChangeViewMode('canvas')}
              className={`flex items-center space-x-1 px-2.5 py-1 rounded-md transition-all ${
                viewMode === 'canvas'
                  ? 'bg-neutral-800 text-cyan-300 font-semibold shadow-[0_0_10px_rgba(6,182,212,0.2)]'
                  : 'text-neutral-400 hover:text-white'
              }`}
              title="Canvas Focus: Expands graph canvas to maximum width"
            >
              <Eye className="w-3 h-3" />
              <span className="hidden sm:inline">Canvas Focus</span>
            </button>

            <button
              onClick={() => onChangeViewMode('report')}
              className={`flex items-center space-x-1 px-2.5 py-1 rounded-md transition-all ${
                viewMode === 'report'
                  ? 'bg-neutral-800 text-emerald-300 font-semibold shadow-[0_0_10px_rgba(16,185,129,0.2)]'
                  : 'text-neutral-400 hover:text-white'
              }`}
              title="Report Focus: Expands remediation audit panel into roomy document view"
            >
              <BookOpen className="w-3 h-3" />
              <span className="hidden sm:inline">Report Focus</span>
            </button>
          </div>

          {/* Zoom Buttons */}
          <div className="flex items-center space-x-1 bg-[#0a0a0a]/90 backdrop-blur-md border border-white/[0.08] rounded-lg p-1">
            <button
              onClick={() => setTransform((prev) => ({ ...prev, k: Math.min(2.5, prev.k * 1.15) }))}
              className="p-1 hover:bg-neutral-800 text-neutral-300 hover:text-white rounded"
              title="Zoom In"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setTransform((prev) => ({ ...prev, k: Math.max(0.4, prev.k * 0.85) }))}
              className="p-1 hover:bg-neutral-800 text-neutral-300 hover:text-white rounded"
              title="Zoom Out"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={recenter}
              className="p-1 hover:bg-neutral-800 text-neutral-300 hover:text-white rounded"
              title="Recenter View"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Interactive SVG Architecture Canvas */}
      <svg
        ref={svgRef}
        className="w-full h-full cursor-grab active:cursor-grabbing flex-1"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          handleMouseUp();
          setHoveredNode(null);
        }}
        onWheel={handleWheel}
      >
        <defs>
          {/* Jewel Glow Filters */}
          <filter id="glow-gold" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="0" stdDeviation="5" floodColor="#F59E0B" floodOpacity="0.8" />
          </filter>
          <filter id="glow-emerald" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="0" stdDeviation="5" floodColor="#10B981" floodOpacity="0.8" />
          </filter>
          <filter id="glow-blue" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="0" stdDeviation="5" floodColor="#3B82F6" floodOpacity="0.8" />
          </filter>
          <filter id="glow-cyan" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="0" stdDeviation="5" floodColor="#06B6D4" floodOpacity="0.8" />
          </filter>
          <filter id="glow-crimson" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="0" stdDeviation="8" floodColor="#F43F5E" floodOpacity="1" />
          </filter>

          {/* Marker Arrows */}
          <marker id="arrow-default" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#333333" />
          </marker>
          <marker id="arrow-crimson" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#F43F5E" />
          </marker>
          <marker id="arrow-emerald" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#10B981" />
          </marker>
        </defs>

        <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.k})`}>
          {/* Tier Background Guidelines */}
          <g className="opacity-15 pointer-events-none">
            <line x1="20" y1="95" x2="1220" y2="95" stroke="#F59E0B" strokeDasharray="4 8" strokeWidth="1" />
            <text x="30" y="85" fill="#F59E0B" fontSize="9" fontFamily="monospace">TIER 1 • COMPANY BRAIN: ADRs & EPISODIC WORKAROUNDS</text>

            <line x1="20" y1="260" x2="1220" y2="260" stroke="#10B981" strokeDasharray="4 8" strokeWidth="1" />
            <text x="30" y="250" fill="#10B981" fontSize="9" fontFamily="monospace">TIER 2 • ENGINEERING TEAMS & TECH LEADS</text>

            <line x1="20" y1="430" x2="1220" y2="430" stroke="#3B82F6" strokeDasharray="4 8" strokeWidth="1" />
            <text x="30" y="420" fill="#3B82F6" fontSize="9" fontFamily="monospace">TIER 3 • MICROSERVICES & ENDPOINT CONTRACTS</text>

            <line x1="20" y1="600" x2="1220" y2="600" stroke="#F43F5E" strokeDasharray="4 8" strokeWidth="1" />
            <text x="30" y="590" fill="#F43F5E" fontSize="9" fontFamily="monospace">TIER 4 • TARGET SCHEMA FIELDS & ACTIVE PROPOSAL</text>
          </g>

          {/* Graph Edges / Links */}
          <g className="edges">
            {links.map((link, idx) => {
              const source = nodeMap.get(link.source);
              const target = nodeMap.get(link.target);
              if (!source || !target || source.x === undefined || source.y === undefined || target.x === undefined || target.y === undefined) return null;

              const isSourceInPath = highlightedNodeIds.has(source.id);
              const isTargetInPath = highlightedNodeIds.has(target.id);
              const isLaser = isSourceInPath && isTargetInPath;

              if (isolateCollision && highlightedNodeIds.size > 0 && !isLaser) {
                return null;
              }

              const isMemoryLink = link.type === 'APPLIES_TO';
              const strokeColor = isLaser
                ? isMemoryLink
                  ? '#10B981'
                  : '#F43F5E'
                : '#222222';

              const strokeWidth = isLaser ? 2.5 : 1;
              const marker = isLaser
                ? isMemoryLink
                  ? 'url(#arrow-emerald)'
                  : 'url(#arrow-crimson)'
                : 'url(#arrow-default)';

              const dx = target.x - source.x;
              const dy = target.y - source.y;
              const dr = Math.sqrt(dx * dx + dy * dy) * 1.25;

              return (
                <path
                  key={`link-${idx}`}
                  d={`M ${source.x} ${source.y} A ${dr} ${dr} 0 0,1 ${target.x} ${target.y}`}
                  fill="none"
                  stroke={strokeColor}
                  strokeWidth={strokeWidth}
                  strokeDasharray={isLaser ? '6 4' : undefined}
                  className={isLaser ? 'animate-laser-flow' : ''}
                  markerEnd={marker}
                  opacity={!isLaser && highlightedNodeIds.size > 0 ? 0.15 : 0.8}
                />
              );
            })}
          </g>

          {/* Graph Nodes */}
          <g className="nodes">
            {layoutNodes.map((node) => {
              const isHighlighted = highlightedNodeIds.has(node.id);
              if (isolateCollision && highlightedNodeIds.size > 0 && !isHighlighted) {
                return null;
              }

              const isViolated = isHighlighted && (node.label === 'ADR' || node.label === 'SchemaField' || node.label === 'Endpoint');
              const visual = getNodeVisual(node.label, isViolated, node.properties?.status);
              const isSelected = selectedNode?.id === node.id;
              const isHovered = hoveredNode?.id === node.id;
              const opacity = highlightedNodeIds.size > 0 && !isHighlighted ? 0.25 : 1;
              const shortCode = getNodeShortCode(node);

              return (
                <g
                  key={`node-${node.id}`}
                  transform={`translate(${node.x}, ${node.y})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectNode(node);
                  }}
                  onMouseEnter={(e) => {
                    const rect = svgRef.current?.getBoundingClientRect();
                    if (rect) {
                      setHoverPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
                    }
                    setHoveredNode(node);
                  }}
                  onMouseLeave={() => setHoveredNode(null)}
                  className="cursor-pointer transition-opacity duration-300"
                  opacity={opacity}
                >
                  {/* Outer Breathing Halo for Highlighted / Violated Nodes */}
                  {(isHighlighted || isSelected || isHovered) && (
                    <circle
                      r={isSelected || isHovered ? 24 : 20}
                      fill="none"
                      stroke={visual.stroke}
                      strokeWidth="1.5"
                      strokeDasharray="4 2"
                      className="animate-spin"
                      style={{ animationDuration: '8s' }}
                    />
                  )}

                  {/* Core Node Circle */}
                  <circle
                    r={isSelected || isHovered ? 16 : 13}
                    fill="#080808"
                    stroke={visual.stroke}
                    strokeWidth={isSelected || isHovered ? 2.5 : 1.8}
                    filter={visual.filter}
                    className="hover:scale-115 transition-transform"
                  />

                  {/* Inner Node Accent Dot */}
                  <circle r={isSelected ? 5 : 3.5} fill={visual.stroke} />

                  {/* SHORT CODE ONLY (ADR-001, INC-2023-42, etc.) */}
                  <text
                    y={25}
                    textAnchor="middle"
                    fill="#FFFFFF"
                    fontSize="10"
                    fontFamily="monospace"
                    fontWeight="600"
                    className="pointer-events-none drop-shadow-md tracking-tight"
                  >
                    {shortCode}
                  </text>

                  {/* Subtitle Label Badge */}
                  <text
                    y={36}
                    textAnchor="middle"
                    fill="#737373"
                    fontSize="8"
                    fontFamily="monospace"
                    className="pointer-events-none uppercase tracking-wider"
                  >
                    {node.label}
                  </text>
                </g>
              );
            })}
          </g>
        </g>
      </svg>

      {/* Floating Hover Tooltip (Resend-Style Instant Peek with Boundary-Aware Flip) */}
      {hoveredNode && !selectedNode && (() => {
        const containerWidth = svgRef.current?.clientWidth || 600;
        const containerHeight = svgRef.current?.clientHeight || 600;
        const isNearRightEdge = hoverPos.x > containerWidth * 0.65;

        return (
          <div
            className="absolute pointer-events-none z-40 bg-[#0a0a0a]/95 backdrop-blur-xl border border-white/[0.15] rounded-xl p-3 shadow-2xl w-64 transition-all duration-150 animate-in fade-in"
            style={{
              left: isNearRightEdge ? hoverPos.x - 15 : hoverPos.x + 15,
              transform: isNearRightEdge ? 'translateX(-100%)' : 'none',
              top: Math.max(20, Math.min(hoverPos.y - 40, containerHeight - 160)),
            }}
          >
            <div className="flex items-center space-x-1.5 mb-1.5">
              <span
                className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded font-bold border ${
                  getNodeVisual(hoveredNode.label, false).badgeBg
                }`}
              >
                {hoveredNode.label}
              </span>
              <span className="text-[10px] font-mono text-neutral-400 truncate">
                {getNodeShortCode(hoveredNode)}
              </span>
            </div>

            <h5 className="text-xs font-semibold text-white leading-snug">
              {hoveredNode.properties?.title || hoveredNode.properties?.name || hoveredNode.name}
            </h5>

            {hoveredNode.properties?.expected_value && (
              <p className="text-[10px] font-mono text-emerald-400 mt-1">
                Mandates: {hoveredNode.properties.expected_value}
              </p>
            )}

            {hoveredNode.properties?.slack_channel && (
              <p className="text-[10px] font-mono text-cyan-400 mt-1">
                Slack: {hoveredNode.properties.slack_channel}
              </p>
            )}

            <p className="text-[9px] text-neutral-500 font-mono mt-1.5 border-t border-white/[0.06] pt-1">
              Click node to view full graph inspector
            </p>
          </div>
        );
      })()}

      {/* Floating Glassmorphic Node Inspector Card (On Click) */}
      {selectedNode && (
        <div className="absolute top-14 right-4 w-80 bg-[#0a0a0a]/90 backdrop-blur-2xl border border-white/[0.12] rounded-xl p-4 shadow-2xl z-30 animate-in fade-in slide-in-from-right duration-200">
          <div className="flex items-center justify-between pb-2 mb-3 border-b border-white/[0.08]">
            <div className="flex items-center space-x-2">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
              <span className="text-xs font-mono font-bold text-neutral-300 uppercase">
                {selectedNode.label} INSPECTOR
              </span>
            </div>
            <button
              onClick={() => onSelectNode(null)}
              className="p-1 hover:bg-neutral-800 rounded text-neutral-400 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="space-y-2.5">
            <div>
              <span className="text-[10px] uppercase font-mono text-neutral-500">Node Identifier</span>
              <p className="text-xs font-semibold text-white leading-snug">
                {selectedNode.properties?.title || selectedNode.properties?.name || selectedNode.name}
              </p>
            </div>

            {selectedNode.properties && Object.keys(selectedNode.properties).length > 0 && (
              <div className="space-y-1.5 pt-1">
                <span className="text-[10px] uppercase font-mono text-neutral-500">Properties</span>
                <div className="bg-[#050505] p-2.5 rounded-lg border border-white/[0.06] space-y-1 max-h-48 overflow-y-auto text-xs font-mono">
                  {Object.entries(selectedNode.properties).map(([k, v]) => (
                    <div key={k} className="flex justify-between text-[11px] py-0.5 border-b border-white/[0.04] last:border-none">
                      <span className="text-neutral-400">{k}:</span>
                      <span className="text-amber-300 truncate max-w-[150px] font-medium" title={String(v)}>
                        {String(v)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Bottom Graph Legend Overlay */}
      <div className="absolute bottom-3 left-4 right-4 z-10 flex flex-wrap items-center justify-between pointer-events-none">
        <div className="flex items-center space-x-4 px-3 py-1.5 bg-[#0a0a0a]/90 backdrop-blur-md border border-white/[0.08] rounded-full text-[11px] font-mono pointer-events-auto">
          <div className="flex items-center space-x-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_8px_#F59E0B]" />
            <span className="text-neutral-300">:ADR & :Field</span>
          </div>
          <div className="flex items-center space-x-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#10B981]" />
            <span className="text-neutral-300">:Episode & :Team</span>
          </div>
          <div className="flex items-center space-x-1.5">
            <span className="w-2 h-2 rounded-full bg-blue-500 shadow-[0_0_8px_#3B82F6]" />
            <span className="text-neutral-300">:Service & :Endpoint</span>
          </div>
          <div className="flex items-center space-x-1.5">
            <span className="w-2 h-2 rounded-full bg-rose-500 shadow-[0_0_8px_#F43F5E]" />
            <span className="text-neutral-300">:Proposal (Conflict)</span>
          </div>
          <div className="flex items-center space-x-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#10B981]" />
            <span className="text-neutral-300">:Proposal (Approved)</span>
          </div>
        </div>

        <span className="text-[10px] font-mono text-neutral-500 hidden md:inline">
          Pan: Drag • Zoom: Scroll • Hover: Peek • Click: Inspect
        </span>
      </div>
    </div>
  );
};
