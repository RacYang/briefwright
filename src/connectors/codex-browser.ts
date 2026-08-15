import type { SourceDefinition } from "../config/types.js";
import type { CaptureEnvelope, Connector, ConnectorContext } from "./types.js";

export type CodexBrowserSource = Omit<SourceDefinition, "connector"> & { connector: { type: "codex-browser"; config: { username: string } } };
export function isCodexBrowserSource(source: SourceDefinition): source is CodexBrowserSource { return source.connector.type === "codex-browser"; }

export class CodexBrowserConnector implements Connector<CodexBrowserSource> {
  readonly descriptor = { type: "codex-browser", version: "1.0.0", title: "Codex read-only browser capture bridge", requiresCredentials: false,
    capabilities: ["external-capture", "clue-only", "read-only-browser"], owner: "briefwright-core", riskLabels: ["interactive-browser", "untrusted-content"],
    configSchema: { type: "object", additionalProperties: false, required: ["username"], properties: { username: { type: "string", pattern: "^[A-Za-z0-9_]{1,15}$" } } },
    examples: [{ username: "OpenAI" }], authentication: { required: false, secretFields: [] } };
  async check(source: CodexBrowserSource) {
    return {
      ok: false,
      detail: `@${source.connector.config.username} is not verified by doctor; validate a current read-only browser capture bundle before preview or run`,
    };
  }
  async capture(_source: CodexBrowserSource, _context: ConnectorContext): Promise<CaptureEnvelope[]> { throw new Error("Codex browser sources require a validated external capture bundle"); }
}
