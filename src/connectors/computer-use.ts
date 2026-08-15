import type { SourceDefinition } from "../config/types.js";
import type { CaptureEnvelope, Connector, ConnectorContext } from "./types.js";

export type ComputerUseSource = Omit<SourceDefinition, "connector"> & {
  connector: { type: "computer-use"; config: { url: string; allowedHosts?: string[] } };
};

export function isComputerUseSource(source: SourceDefinition): source is ComputerUseSource {
  return source.connector.type === "computer-use";
}

export function computerUseAllowedHosts(source: ComputerUseSource): string[] {
  return [...new Set(source.connector.config.allowedHosts ?? [new URL(source.connector.config.url).hostname])]
    .map((host) => host.toLowerCase());
}

export class ComputerUseConnector implements Connector<ComputerUseSource> {
  readonly descriptor = {
    type: "computer-use",
    version: "1.0.0",
    title: "Codex read-only Computer Use capture bridge",
    requiresCredentials: false,
    capabilities: ["external-capture", "dynamic-ui", "read-only-computer-use"],
    owner: "briefwright-core",
    riskLabels: ["interactive-ui", "untrusted-content"],
    configSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", pattern: "^https://" },
        allowedHosts: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          uniqueItems: true,
          items: { type: "string", pattern: "^[A-Za-z0-9.-]+$" },
        },
      },
    },
    examples: [{ url: "https://www.example.com/news", allowedHosts: ["www.example.com"] }],
    authentication: { required: false, secretFields: [] },
  };

  async check(source: ComputerUseSource) {
    return {
      ok: false,
      detail: `${source.connector.config.url} is not verified by doctor; validate a current read-only Computer Use capture bundle before preview or run`,
    };
  }

  async capture(_source: ComputerUseSource, _context: ConnectorContext): Promise<CaptureEnvelope[]> {
    throw new Error("Computer Use sources require a validated external capture bundle");
  }
}
