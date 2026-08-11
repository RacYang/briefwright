import type { SourceDefinition } from "../config/types.js";

export interface ConnectorDescriptor {
  type: string;
  version: string;
  title: string;
  requiresCredentials: boolean;
  capabilities: string[];
  owner: string;
  riskLabels: string[];
  configSchema: Record<string, unknown>;
  examples: Array<Record<string, unknown>>;
  authentication: { required: boolean; secretFields: string[] };
}

export interface CaptureEnvelope {
  sourceId: string;
  externalKey: string;
  canonicalUrl: string;
  title: string;
  summary: string;
  capturedAt: string;
  publishedAt?: string;
  contentHash: string;
  evidenceClass: "primary" | "secondary";
}

export interface CheckResult {
  ok: boolean;
  detail: string;
}

export interface Connector<TSource extends SourceDefinition = SourceDefinition> {
  readonly descriptor: ConnectorDescriptor;
  check(source: TSource, context: ConnectorContext): Promise<CheckResult>;
  capture(source: TSource, context: ConnectorContext): Promise<CaptureEnvelope[]>;
}

export interface ConnectorContext {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  now(): Date;
  cursor?: Record<string, unknown>;
  setCursor?(value: Record<string, unknown>): void;
}
