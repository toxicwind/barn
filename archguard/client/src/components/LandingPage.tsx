import React, { useState } from 'react';
import { Shield, ArrowRight, ExternalLink } from 'lucide-react';
import { LandingGraphHero } from './LandingGraphHero';

interface LandingPageProps {
  onLaunch: () => void;
  stats: { totalNodes: number; totalEdges: number } | null;
}

export const LandingPage: React.FC<LandingPageProps> = ({ onLaunch, stats }) => {
  return (
    <div className="min-h-screen bg-[#000000] text-white selection:bg-amber-500/30 selection:text-amber-200 overflow-x-hidden font-sans">
      {/* Ambient Top Spotlight Gradients */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl h-[480px] bg-[radial-gradient(ellipse_at_top,#f59e0b12,transparent_65%)] pointer-events-none -z-10" />
      <div className="absolute top-24 right-10 w-80 h-80 bg-cyan-500/5 rounded-full blur-3xl pointer-events-none -z-10" />

      {/* 1. Header / Navbar */}
      <header className="sticky top-0 z-50 h-14 border-b border-white/[0.08] bg-[#000000]/80 backdrop-blur-xl px-6 lg:px-12 flex items-center justify-between">
        {/* Brand */}
        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-2.5">
            <div className="relative">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-amber-500/20 via-neutral-900 to-black border border-amber-500/40 flex items-center justify-center shadow-[0_0_15px_rgba(245,158,11,0.25)]">
                <Shield className="w-3.5 h-3.5 text-amber-400" />
              </div>
              <div className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-emerald-500 animate-pulse border-2 border-black" />
            </div>

            <div className="flex items-center space-x-2">
              <span className="font-bold text-sm tracking-tight text-white font-mono">ArchGuard</span>
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-white/[0.04] text-neutral-300 border border-white/10">
                v1.0 • PRE-MERGE
              </span>
            </div>
          </div>
        </div>

        {/* Center Nav Links */}
        <nav className="hidden md:flex items-center space-x-8 text-xs font-mono text-neutral-400">
          <a href="#features" className="hover:text-white transition-colors">
            // 01. ENGINE
          </a>
          <a href="#pipeline" className="hover:text-white transition-colors">
            // 02. PIPELINE
          </a>
          <a href="#episodic" className="hover:text-white transition-colors">
            // 03. MEMORY
          </a>
          <a
            href="https://github.com"
            target="_blank"
            rel="noreferrer"
            className="hover:text-white transition-colors flex items-center gap-1"
          >
            DOCS <ExternalLink className="w-3 h-3 text-neutral-500" />
          </a>
        </nav>

        {/* CTA Button */}
        <div className="flex items-center space-x-3">
          <button
            onClick={onLaunch}
            className="group rounded-md px-3.5 py-1.5 text-xs font-mono font-medium bg-white text-black hover:bg-neutral-200 transition-all flex items-center gap-1.5 shadow-[0_0_15px_rgba(255,255,255,0.2)]"
          >
            <span>Launch Command Center</span>
            <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
          </button>
        </div>
      </header>

      {/* 2. Hero Section (Left-Right Split) */}
      <section className="relative pt-12 pb-20 px-6 lg:px-12 max-w-7xl mx-auto">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-8 items-center">
          {/* Left Column: Copy & Actions */}
          <div className="lg:col-span-6 space-y-6">
            {/* Hackathon Badge */}
            <div className="inline-flex items-center space-x-2 px-3 py-1 rounded-full bg-white/[0.03] border border-white/10 text-xs font-mono text-neutral-300">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
              </span>
              <span>WeMakeDevs x FalkorDB Graph Hacks</span>
              <span className="text-neutral-600">/</span>
              <span className="text-amber-400 font-medium">Company Brain Track</span>
            </div>

            {/* Headline */}
            <h1 className="text-4xl sm:text-5xl lg:text-[54px] font-extrabold tracking-tight text-white leading-[1.08]">
              The Pre-Merge Guardian for{' '}
              <span className="bg-gradient-to-r from-amber-400 via-amber-200 to-white bg-clip-text text-transparent">
                Autonomous Teams.
              </span>
            </h1>

            {/* Subtitle */}
            <p className="text-base text-neutral-400 leading-relaxed max-w-xl">
              Catch invisible cross-team conflicts, API contract breakages, and Architecture Decision
              Record (ADR) violations <em>before</em> code merges. Built on deterministic multi-hop{' '}
              <strong className="text-neutral-200">FalkorDB</strong> graph traversals and episodic precedent memory.
            </p>

            {/* CTA Buttons */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 pt-2">
              <button
                onClick={onLaunch}
                className="px-6 py-3 rounded-lg bg-white hover:bg-neutral-200 text-black font-semibold text-xs font-mono flex items-center justify-center gap-2 transition-all shadow-[0_0_25px_rgba(255,255,255,0.2)] hover:scale-[1.02] group"
              >
                <span>LAUNCH COMMAND CENTER</span>
                <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
              </button>

              <a
                href="#features"
                className="px-5 py-3 rounded-lg bg-neutral-900/80 hover:bg-neutral-800 border border-white/10 hover:border-white/20 text-neutral-300 font-mono text-xs flex items-center justify-center gap-2 transition-all"
              >
                <span>EXPLORE ARCHITECTURE</span>
              </a>
            </div>

            {/* Value Tokens */}
            <div className="pt-3 flex flex-wrap items-center gap-y-2 gap-x-5 text-xs font-mono text-neutral-400">
              <div className="flex items-center gap-1.5">
                <span className="text-emerald-400 font-bold">[✓]</span>
                <span>Deterministic Multi-Hop Cypher</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-emerald-400 font-bold">[✓]</span>
                <span>Deterministic Detection, LLM-Explained</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-emerald-400 font-bold">[✓]</span>
                <span>Episodic Memory Precedents</span>
              </div>
            </div>
          </div>

          {/* Right Column: Constellation Graph Hero Widget */}
          <div className="lg:col-span-6 flex justify-center">
            <LandingGraphHero />
          </div>
        </div>
      </section>

      {/* 3. Live Stats & Engine Ticker */}
      <section className="border-y border-white/[0.08] bg-[#050505] py-3.5 px-6 lg:px-12">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4 text-xs font-mono">
          <div className="flex items-center space-x-2 text-neutral-400">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <span className="text-white font-semibold">LIVE FALKORDB TOPOLOGY:</span>
            <span className="text-emerald-400 font-bold">
              {stats ? `${stats.totalNodes} Nodes • ${stats.totalEdges} Relationships` : '31 Nodes • 43 Relationships'}
            </span>
          </div>

          <div className="flex items-center space-x-6 text-neutral-400">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
              <span>TRAVERSAL: &lt;1ms</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              <span>COMPANY BRAIN: ACTIVE</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span>EPISODIC MEMORY: GROUNDED</span>
            </div>
          </div>
        </div>
      </section>

      {/* 4. Core Features Grid */}
      <section id="features" className="py-20 px-6 lg:px-12 max-w-7xl mx-auto space-y-14">
        <div className="text-center max-w-3xl mx-auto space-y-3">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded bg-white/[0.04] border border-white/10 text-[11px] font-mono text-neutral-300">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span>ENGINEERING FOUNDATIONS</span>
          </div>
          <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-white">
            The Graph Does the Work. The LLM Explains the Proof.
          </h2>
          <p className="text-neutral-400 text-sm leading-relaxed">
            Probabilistic LLMs hallucinate breaking schema contracts. ArchGuard eliminates guesswork by
            running deterministic multi-hop Cypher queries directly inside FalkorDB.
          </p>
        </div>

        {/* 3 High-End Engineering Feature Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Card 1: Deterministic Cypher */}
          <div className="relative rounded-xl bg-[#090909] border border-white/[0.08] hover:border-white/20 transition-all duration-300 p-5 flex flex-col justify-between group shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs px-2 py-0.5 rounded bg-white/[0.04] border border-white/10 text-amber-400 font-semibold">
                  [:CYPHER]
                </span>
                <span className="font-mono text-[10px] text-neutral-500">LATENCY: 0.8ms</span>
              </div>

              <h3 className="text-base font-bold text-white tracking-tight">
                Deterministic Multi-Hop Cypher
              </h3>

              <p className="text-xs text-neutral-400 leading-relaxed">
                Deterministic conflict detection. FalkorDB executes multi-hop traversals in sub-millisecond
                time to find exact collisions between PR modifications and enforced ADR policies.
              </p>
            </div>

            {/* Real Cypher Traversal Preview */}
            <div className="mt-5 pt-3.5 border-t border-white/[0.08]">
              <div className="bg-black/90 rounded-lg p-3 font-mono text-[10px] leading-relaxed text-amber-300/90 border border-white/[0.08] overflow-x-auto">
                <div className="text-neutral-500">// FalkorDB Graph Traversal</div>
                <div className="text-white">MATCH (p:Proposal)-[:TARGETS]-&gt;(f)</div>
                <div className="text-white">MATCH (a:ADR)-[:GOVERNS]-&gt;(f)</div>
                <div className="text-rose-400">WHERE f.type &lt;&gt; a.expected_value</div>
                <div className="text-cyan-400">RETURN a.code, a.mandate</div>
              </div>
            </div>
          </div>

          {/* Card 2: Company Brain Track */}
          <div className="relative rounded-xl bg-[#090909] border border-white/[0.08] hover:border-white/20 transition-all duration-300 p-5 flex flex-col justify-between group shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs px-2 py-0.5 rounded bg-white/[0.04] border border-white/10 text-cyan-400 font-semibold">
                  [:GRAPH_CATALOG]
                </span>
                <span className="font-mono text-[10px] text-neutral-500">TOPOLOGY: MULTI-TIER</span>
              </div>

              <h3 className="text-base font-bold text-white tracking-tight">
                Company Brain Knowledge Graph
              </h3>

              <p className="text-xs text-neutral-400 leading-relaxed">
                Connects teams, microservices, endpoints, schemas, and live Markdown ADR files into a
                living, breathing organizational graph. Trace exact blast radius down to impacted Slack
                channels and Tech Leads.
              </p>
            </div>

            {/* Real Graph Contract Schema Preview */}
            <div className="mt-5 pt-3.5 border-t border-white/[0.08]">
              <div className="bg-black/90 rounded-lg p-3 font-mono text-[10px] leading-relaxed text-neutral-300 border border-white/[0.08] overflow-x-auto">
                <div className="text-neutral-500">// Node Contract Schema</div>
                <div><span className="text-cyan-400">"governed_by"</span>: <span className="text-amber-300">"ADR-001"</span>,</div>
                <div><span className="text-cyan-400">"target"</span>: <span className="text-amber-300">"user_id"</span>,</div>
                <div><span className="text-cyan-400">"mandate"</span>: <span className="text-emerald-400">"UUIDv4"</span>,</div>
                <div><span className="text-cyan-400">"blast_radius"</span>: [<span className="text-neutral-400">"billing"</span>, <span className="text-neutral-400">"checkout"</span>]</div>
              </div>
            </div>
          </div>

          {/* Card 3: Episodic Memory */}
          <div className="relative rounded-xl bg-[#090909] border border-white/[0.08] hover:border-white/20 transition-all duration-300 p-5 flex flex-col justify-between group shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs px-2 py-0.5 rounded bg-white/[0.04] border border-white/10 text-emerald-400 font-semibold">
                  [:EPISODIC_MEMORY]
                </span>
                <span className="font-mono text-[10px] text-neutral-500">PRECEDENT: ACTIVE</span>
              </div>

              <h3 className="text-base font-bold text-white tracking-tight">
                Cross-Session Precedent Memory
              </h3>

              <p className="text-xs text-neutral-400 leading-relaxed">
                When a conflict occurs, FalkorDB recalls past architectural incidents and approved
                compromises, surfacing proven workarounds so engineers never debate the same problem twice.
              </p>
            </div>

            {/* Real Episodic Incident Record Preview */}
            <div className="mt-5 pt-3.5 border-t border-white/[0.08]">
              <div className="bg-black/90 rounded-lg p-3 font-mono text-[10px] leading-relaxed text-emerald-300/90 border border-white/[0.08] overflow-x-auto">
                <div className="text-neutral-500">// FalkorDB Precedent Record</div>
                <div><span className="text-neutral-400">"incident"</span>: <span className="text-white">"INC-2023-42"</span>,</div>
                <div><span className="text-neutral-400">"pattern"</span>: <span className="text-emerald-400">"Dual-Write Shadow Column"</span>,</div>
                <div><span className="text-neutral-400">"approved_by"</span>: <span className="text-white">"@alex_lead"</span>,</div>
                <div><span className="text-neutral-400">"status"</span>: <span className="text-emerald-400">"Permanent Workaround"</span></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 5. 3-Agent Graph-Mediated Pipeline Section */}
      <section id="pipeline" className="py-20 px-6 lg:px-12 max-w-7xl mx-auto border-t border-white/[0.08]">
        <div className="space-y-12">
          <div className="text-center max-w-2xl mx-auto space-y-3">
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded bg-white/[0.04] border border-white/10 text-[11px] font-mono text-neutral-300">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
              <span>STATE HANDOFF PROTOCOL</span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
              3 Agents. 1 Shared Graph State. Zero Prompt Bloat.
            </h2>
            <p className="text-neutral-400 text-xs sm:text-sm">
              Our agents do not pass gigabytes of conversation history back and forth. They read and
              write directly to the <code className="text-amber-400 font-mono">:Proposal</code> subgraph in FalkorDB.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 relative">
            {/* Step 1 */}
            <div className="rounded-xl bg-[#090909] border border-white/[0.08] hover:border-white/20 transition-all p-5 space-y-3 relative shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono px-2 py-0.5 rounded bg-white/[0.04] text-neutral-300 border border-white/10 font-bold">
                  [01] EXTRACTOR
                </span>
                <span className="text-neutral-500 font-mono text-[10px]">STAGE: PARSE</span>
              </div>
              <h4 className="text-sm font-bold text-white font-mono">ProposalExtractorAgent</h4>
              <p className="text-xs text-neutral-400 leading-relaxed">
                Ingests raw Git diff, SQL migration, or OpenAPI spec. Binds target entities to the
                catalog and commits <code className="text-neutral-200 font-mono">:Proposal &#123;status: 'PARSED'&#125;</code>.
              </p>
              <div className="pt-2 text-[10px] font-mono text-neutral-500 border-t border-white/[0.06]">
                HANDOFF: <span className="text-amber-400">returns proposalId only</span>
              </div>
            </div>

            {/* Step 2 */}
            <div className="rounded-xl bg-[#090909] border border-white/[0.08] hover:border-white/20 transition-all p-5 space-y-3 relative shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono px-2 py-0.5 rounded bg-white/[0.04] text-rose-400 border border-white/10 font-bold">
                  [02] AUDITOR
                </span>
                <span className="text-neutral-500 font-mono text-[10px]">STAGE: AUDIT</span>
              </div>
              <h4 className="text-sm font-bold text-white font-mono">GraphAuditorAgent</h4>
              <p className="text-xs text-neutral-400 leading-relaxed">
                Queries FalkorDB via deterministic Cypher. Traverses upstream ADR rules and downstream
                service consumers; writes <code className="text-rose-400 font-mono">[:VIOLATES_ADR]</code>.
              </p>
              <div className="pt-2 text-[10px] font-mono text-neutral-500 border-t border-white/[0.06]">
                HANDOFF: <span className="text-cyan-400">persists status: 'CHECKED'</span>
              </div>
            </div>

            {/* Step 3 */}
            <div className="rounded-xl bg-[#090909] border border-white/[0.08] hover:border-white/20 transition-all p-5 space-y-3 relative shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono px-2 py-0.5 rounded bg-white/[0.04] text-emerald-400 border border-white/10 font-bold">
                  [03] ADVISOR
                </span>
                <span className="text-neutral-500 font-mono text-[10px]">STAGE: RESOLVE</span>
              </div>
              <h4 className="text-sm font-bold text-white font-mono">ResolutionAdvisorAgent</h4>
              <p className="text-xs text-neutral-400 leading-relaxed">
                Recalls FalkorDB episodic memory precedents, generates a grounded migration plan with Slack
                pings, and writes resolution back to graph.
              </p>
              <div className="pt-2 text-[10px] font-mono text-neutral-500 border-t border-white/[0.06]">
                HANDOFF: <span className="text-emerald-400">persists status: 'RESOLVED'</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 6. High-Impact Bottom CTA */}
      <section className="py-20 px-6 lg:px-12 max-w-5xl mx-auto text-center space-y-6">
        <div className="relative p-10 sm:p-12 rounded-2xl bg-[#080808] border border-white/[0.1] shadow-2xl overflow-hidden shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)]">
          <div className="relative z-10 space-y-4 max-w-2xl mx-auto">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-white/[0.04] border border-white/10 text-[11px] font-mono text-neutral-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>PRODUCTION ENGINE READY</span>
            </div>

            <h2 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
              Ready to Guard Your Architecture?
            </h2>

            <p className="text-neutral-400 text-xs sm:text-sm leading-relaxed">
              Explore preset PR violations, test custom SQL migrations, ingest live Markdown ADR files,
              and watch multi-hop Cypher queries illuminate in real time.
            </p>

            <div className="pt-3 flex justify-center">
              <button
                onClick={onLaunch}
                className="px-6 py-3.5 rounded-lg bg-white hover:bg-neutral-200 text-black font-mono font-semibold text-xs flex items-center gap-2 transition-all shadow-[0_0_25px_rgba(255,255,255,0.2)] hover:scale-105"
              >
                <span>ENTER COMMAND CENTER</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 7. Minimal Resend Footer */}
      <footer className="border-t border-white/[0.08] py-8 px-6 lg:px-12 text-center text-xs font-mono text-neutral-500 space-y-2">
        <div className="flex items-center justify-center space-x-2 text-neutral-400">
          <Shield className="w-3.5 h-3.5 text-amber-400" />
          <span className="font-bold text-white">ArchGuard</span>
          <span>— Built for WeMakeDevs x FalkorDB Graph Hacks</span>
        </div>
        <p className="text-[11px] text-neutral-600">
          Deterministic Cypher • Multi-Tenant Knowledge Graph • Episodic Precedent Memory
        </p>
      </footer>
    </div>
  );
};
