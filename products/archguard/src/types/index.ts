export interface ADRFrontmatter {
  id: string;
  code: string;
  title: string;
  status: 'PROPOSED' | 'ACCEPTED' | 'DEPRECATED' | 'SUPERSEDED';
  rule_type: 'SCHEMA_FIELD_CONSTRAINT' | 'ENDPOINT_EXECUTION_MODE' | 'CONTRACT_COMPATIBILITY';
  target_property: string;
  expected_value: string;
  governs_target: string;
  author_handle: string;
}

export interface ADRNode extends ADRFrontmatter {
  content: string;
  created_at?: string;
}

export interface TeamNode {
  id: string;
  name: string;
  slack_channel: string;
  domain: string;
}

export interface PersonNode {
  id: string;
  handle: string;
  name: string;
  role: string;
  email: string;
}

export interface ServiceNode {
  id: string;
  name: string;
  tier: 'tier-1' | 'tier-2' | 'tier-3';
  description: string;
}

export interface EndpointNode {
  id: string;
  path: string;
  method: string;
  contract_policy?: string;
  execution_mode?: string;
}

export interface SchemaFieldNode {
  id: string;
  name: string;
  data_type: string;
  description: string;
}

export interface ArchitecturalEpisodeNode {
  id: string;
  code: string;
  incident_id: string;
  title: string;
  summary: string;
  workaround_pattern: string;
  approved_by: string;
  resolution_date: string;
  trade_offs: string;
  adrCode?: string;
}

export interface ProposalInput {
  proposalId: string;
  title: string;
  rawInput: string;
  author: string;
  targetType: 'SchemaField' | 'Endpoint';
  targetName: string;
  changedProperty: string;
  proposedValue: string;
}

export interface GraphPathElement {
  nodeId: string | number;
  label: string;
  name: string;
}

export interface GraphPath {
  nodes: GraphPathElement[];
  relationshipTypes: string[];
}

export interface AdrViolationFinding {
  adrId: string;
  adrCode: string;
  adrTitle: string;
  ruleType: string;
  targetProperty: string;
  expectedValue: string;
  proposedValue: string;
  authorHandle: string;
  authorName?: string;
  authorTeam?: string;
  authorSlackChannel?: string;
  governsTarget: string;
  explanation: string;
  path: GraphPath;
}

export interface BlastRadiusFinding {
  serviceId: string;
  serviceName: string;
  serviceTier: string;
  owningTeam: string;
  slackChannel: string;
  techLeadHandle: string;
  techLeadName?: string;
  viaEndpoint: string;
  impactLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  path: GraphPath;
}

export interface EpisodicMemoryFinding {
  episodeId: string;
  code?: string;
  incidentId: string;
  title: string;
  summary: string;
  workaroundPattern: string;
  approvedBy: string;
  resolutionDate: string;
  tradeOffs: string;
  relatedAdrCode: string;
  path: GraphPath;
}

export interface AuditResults {
  proposalId: string;
  status: string;
  violations: AdrViolationFinding[];
  blastRadius: BlastRadiusFinding[];
  persistedViolationsCount: number;
  persistedBreaksCount: number;
}

// -------------------------------------------------------------
// Phase 2 Types: LLM, Multi-Agent Handoff, Catalog & Topology
// -------------------------------------------------------------

export interface GraphCatalog {
  fields: { name: string; data_type?: string; execution_mode?: string }[];
  endpoints: { path: string; method: string; execution_mode?: string; contract_policy?: string }[];
  services: { name: string; tier: string }[];
  adrs: { code: string; title: string; target_property: string; expected_value: string; governs_target: string }[];
}

export interface LLMOptions {
  runtimeKey?: string;
  runtimeProvider?: 'openrouter' | 'gemini';
  model?: string;
}

export interface ExtractedProposal {
  title: string;
  targetType: 'SchemaField' | 'Endpoint';
  targetName: string;
  changedProperty: string;
  proposedValue: string;
  author: string;
  summary: string;
  usedProvider: string;
}

export interface ImpactedTeamNotification {
  team: string;
  slackChannel: string;
  recipient: string;
  message: string;
}

export interface RecommendedWorkaround {
  title: string;
  patternName: string;
  stepByStep: string[];
  tradeOffs: string;
  source: 'EPISODIC_MEMORY' | 'ADR_GUIDELINE' | 'SYNTHESIZED';
}

export interface ResolutionAdvice {
  executiveSummary: string;
  conflictAnalysis: string;
  impactedTeamsNotification: ImpactedTeamNotification[];
  recommendedWorkaround: RecommendedWorkaround;
  proposedCompliantSpec: string;
  citations: { adrCode: string; episodeIncidentId?: string; explanation: string }[];
  usedProvider: string;
}

export interface AgentTrace {
  agent: 'ExtractorAgent' | 'AuditorAgent' | 'AdvisorAgent';
  durationMs: number;
  cypherQueries: string[];
  stateTransition: { from: string; to: string };
  summary: string;
  provider?: string;
}

export interface TopologyNode {
  id: string | number;
  label: string;
  name: string;
  properties: Record<string, any>;
}

export interface TopologyLink {
  source: string | number;
  target: string | number;
  type: string;
  properties?: Record<string, any>;
}

export interface GraphTopology {
  nodes: TopologyNode[];
  links: TopologyLink[];
  stats: {
    totalNodes: number;
    totalEdges: number;
    teamsCount: number;
    servicesCount: number;
    endpointsCount: number;
    adrsCount: number;
    episodesCount: number;
  };
}

export interface FullAuditPayload {
  proposalId: string;
  status: string;
  proposal: {
    id: string;
    title: string;
    rawInput: string;
    author: string;
    targetType: string;
    targetName: string;
    changedProperty?: string;
    proposedValue?: string;
  };
  agentTraces: AgentTrace[];
  violations: AdrViolationFinding[];
  blastRadius: BlastRadiusFinding[];
  episodicMemory: EpisodicMemoryFinding[];
  resolution: ResolutionAdvice | null;
  highlightedPath: GraphPath;
  graphTopology: GraphTopology;
}
