export interface GraphNode {
  id: string | number;
  label: string;
  name: string;
  properties: Record<string, any>;
  x?: number;
  y?: number;
}

export interface GraphLink {
  source: string | number;
  target: string | number;
  type: string;
  properties?: Record<string, any>;
}

export interface GraphTopology {
  nodes: GraphNode[];
  links: GraphLink[];
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

export interface GraphPath {
  nodes: { nodeId: string | number; label: string; name: string }[];
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

export interface PresetItem {
  id: string;
  code: string;
  title: string;
  description: string;
  expectedConflict: string;
  rawInput: string;
}
