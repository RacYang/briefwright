import type { PromptPackDefinition, ProviderDefinition } from "../config/types.js";
import type { CaptureEnvelope } from "../connectors/types.js";

export interface ScoredDimension {
  value: number;
  reason: string;
}

export interface ModelAnalysis {
  summary: string;
  whyItMatters: string;
  domain: string;
  claims: string[];
  knowledgePotential: {
    reusableQuestion: boolean;
    mechanismIncrement: boolean;
    durableWithoutVersion: boolean;
    reason: string;
  };
  scores: Record<"authority" | "evidence" | "relevance" | "impact" | "novelty" | "recency" | "actionability", ScoredDimension>;
  exclusions: Array<"unverified" | "duplicate" | "rumor" | "financing-only" | "marketing-only" | "no-substance">;
}

export interface AnalysisContext {
  interests: string[];
  domains: string[];
  prompt: PromptPackDefinition;
  provider: ProviderDefinition;
  projectRoot: string;
}

export interface ModelProvider {
  readonly id: string;
  readonly version: string;
  check(context: AnalysisContext): Promise<{ ok: boolean; detail: string }>;
  analyze(capture: CaptureEnvelope, context: AnalysisContext): Promise<ModelAnalysis>;
}
