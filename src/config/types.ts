export interface BriefingIntent {
  version: 3;
  name: string;
  preset: string;
  interests: string[];
  schedule: "manual" | "daily-at-10" | "weekdays-at-09";
  output: "markdown";
  outputDirectory: string;
  sourceContract?: { path: string; sha256: string };
  model: string | {
    provider: string;
    protocol?: ProviderDefinition["protocol"];
    model?: string;
    reasoningEffort?: ProviderDefinition["reasoningEffort"];
    baseUrl?: string;
    apiKey?: SecretReference;
    allowedHosts?: string[];
    allowInsecureLocalhost?: boolean;
  };
  processStore: "auto" | "sqlite" | {
    driver: "lark" | "postgres" | "mysql" | "sqlite";
    baseToken?: string;
    profile?: string;
    identity?: "user" | "bot";
    xCapture?: "api" | "codex-browser";
    maximumRecordsPerTable?: number;
    tables?: Partial<LarkTableMapping>;
    connection?: SecretReference;
  };
  documentStore: "auto" | "local" | "obsidian" | {
    driver: "local" | "obsidian";
    root?: string;
    briefingDirectory?: string;
  };
}

export interface SecretReference {
  provider: "env" | "file";
  key: string;
}

export interface RuleSnapshot {
  id: string;
  version: string;
  title: string;
}

export interface ProtocolDefinition {
  contractId: string;
  contractVersion: string;
  timezone: string;
  runIdPattern: string;
  sameDayIdempotent: boolean;
  stages: string[];
  activeRuleIds: string[];
  integrity: Record<string, boolean>;
  documents: Record<string, unknown>;
  completionReportFields: string[];
}

export interface ScoreDimensionDefinition {
  id: "authority" | "evidence" | "relevance" | "impact" | "novelty" | "recency" | "actionability";
  weight: number;
}

export interface PolicyDefinition {
  id: string;
  version: string;
  rules: RuleSnapshot[];
  score: {
    dimensions: ScoreDimensionDefinition[];
    dailyThreshold: number;
    reviewMinimum: number;
    dailyMaximum: number;
    perDomainMaximum: number;
  };
  domains: string[];
  retention: { quoteWordLimit: number };
  freshness?: {
    dailyMaximumAgeHours: number;
    reviewMaximumAgeHours: number;
    futureToleranceHours: number;
  };
}

export interface PromptPackDefinition {
  id: string;
  version: string;
  system: string;
  outputSchema: Record<string, unknown>;
}

export interface ProviderDefinition {
  id: string;
  version: string;
  protocol: string;
  model: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  baseUrl: string;
  apiKey?: SecretReference;
  timeoutSeconds: number;
  retries: number;
  endpointPolicy: {
    allowedHosts: string[];
    allowedHostSuffixes?: string[];
    allowInsecureLocalhost?: boolean;
  };
}

export interface LarkTableMapping {
  sources: string;
  runs: string;
  items: string;
  events: string;
  feedback: string;
  experiments: string;
  captures: string;
  rules: string;
  receipts: string;
}

export interface SourceDefinition {
  id: string;
  title: string;
  domain?: string;
  enabled?: boolean;
  sourceType?: "website" | "official-blog" | "official-docs" | "github" | "x" | "paper" | "regulation" | "media" | "other";
  evidenceTier?: "primary" | "clue" | "secondary";
  coverageDomains?: string[];
  priority?: number;
  scheduleState?: {
    frequency?: "daily" | "weekly" | "on-demand";
    lastScanAt?: string;
    lastSuccessAt?: string;
    lastEffectiveUpdateAt?: string;
    nextScanAt?: string;
    humanLocked?: boolean;
  };
  cadence?: { minimumHours: number; defaultHours: number; maximumHours: number };
  connector:
    | {
        type: "github-releases";
        config: { repository: string };
      }
    | {
        type: "rss";
        config: { url: string };
      }
    | {
        type: "webpage";
        config: { url: string };
      }
    | {
        type: "x-api";
        config: { username: string; bearerToken: SecretReference };
      }
    | {
        type: "codex-browser";
        config: { username: string };
      }
    | {
        type: "in-app-browser";
        config: { url: string; allowedHosts?: string[] };
      }
    | {
        type: "computer-use";
        config: { url: string; allowedHosts?: string[] };
      }
    | {
        type: "extension";
        config: { adapter: string; options: Record<string, unknown> };
      };
}

export interface PresetDefinition {
  id: string;
  version: string;
  title: string;
  description: string;
  quality: "strict" | "balanced";
  coverage: "focused" | "balanced" | "broad";
  cost: "low" | "moderate" | "high";
  sources: SourceDefinition[];
}

export interface EffectiveConfig {
  configVersion: 3;
  projectRoot: string;
  name: string;
  preset: PresetDefinition;
  interests: string[];
  schedule: BriefingIntent["schedule"];
  output: {
    format: "markdown";
    directory: string;
  };
  storage: {
    driver: "sqlite";
    path: string;
  };
  controlPlane: {
    driver: "lark" | "postgres" | "mysql" | "sqlite";
    mode: "configured" | "fallback";
    lark?: {
      baseToken: string;
      profile?: string;
      identity: "user" | "bot";
      tables: LarkTableMapping;
      xCapture: "api" | "codex-browser";
      maximumRecordsPerTable?: number;
    };
    connection?: SecretReference;
  };
  documents: {
    driver: "local" | "obsidian";
    mode: "configured" | "fallback";
    root: string;
    briefingDirectory: string;
  };
  runtime: {
    httpConcurrency: number;
    modelConcurrency: number;
    maximumCapturesPerRun: number;
    retries: number;
    timeoutSeconds: number;
  };
  policy: PolicyDefinition;
  prompts: PromptPackDefinition;
  provider: ProviderDefinition;
  protocol: ProtocolDefinition;
  sourceContract?: { path: string; sha256: string };
  provenance: {
    coreVersion: string;
    intentVersion: number;
    presetVersion: string;
    policyVersion: string;
    promptVersion: string;
    providerVersion: string;
    policyOrigin: "packaged" | "approved-experiment";
    controlPlaneRevision?: string;
    contractVersion: string;
    contractDigest: string;
    sourceContractDigest?: string;
  };
  origins: Record<string, string>;
}
