import type { SourceDefinition } from "../config/types.js";
import type { CaptureEnvelope, Connector, ConnectorContext } from "./types.js";

export type InAppBrowserSource = Omit<SourceDefinition, "connector"> & {
  connector: { type: "in-app-browser"; config: { url: string; allowedHosts?: string[] } };
};

export function isInAppBrowserSource(source: SourceDefinition): source is InAppBrowserSource {
  return source.connector.type === "in-app-browser";
}

export function inAppBrowserAllowedHosts(source: InAppBrowserSource): string[] {
  return [...new Set(source.connector.config.allowedHosts ?? [new URL(source.connector.config.url).hostname])]
    .map((host) => host.toLowerCase());
}

export class InAppBrowserConnector implements Connector<InAppBrowserSource> {
  readonly descriptor = {
    type: "in-app-browser",
    version: "1.0.0",
    title: "Codex isolated in-app Browser capture bridge",
    requiresCredentials: false,
    capabilities: ["external-capture", "dynamic-web", "read-only-isolated-browser"],
    owner: "briefwright-core",
    riskLabels: ["untrusted-content"],
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

  async check(source: InAppBrowserSource) {
    return {
      ok: false,
      detail: `${source.connector.config.url} is not verified by doctor; validate a current read-only isolated Browser capture bundle before preview or run`,
    };
  }

  async capture(_source: InAppBrowserSource, _context: ConnectorContext): Promise<CaptureEnvelope[]> {
    throw new Error("In-app Browser sources require a validated external capture bundle");
  }
}
