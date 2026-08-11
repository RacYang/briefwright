export interface BriefingIntent {
  version: 2;
  name: string;
  preset: "ai-daily";
  interests: string[];
  schedule: "manual" | "daily-at-10" | "weekdays-at-09";
  output: "markdown";
  outputDirectory: string;
  ai: "qwen";
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
}

export interface PromptPackDefinition {
  id: string;
  version: string;
  system: string;
  outputSchema: Record<string, unknown>;
}

export interface ProviderDefinition {
  id: "qwen";
  version: string;
  protocol: "openai-chat-completions";
  model: string;
  baseUrl: string;
  apiKey: SecretReference;
  timeoutSeconds: number;
  retries: number;
}

export interface SourceDefinition {
  id: string;
  title: string;
  domain?: string;
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
  configVersion: 2;
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
  provenance: {
    coreVersion: string;
    intentVersion: number;
    presetVersion: string;
    policyVersion: string;
    promptVersion: string;
    providerVersion: string;
    policyOrigin: "packaged" | "approved-experiment";
  };
  origins: Record<string, string>;
}
