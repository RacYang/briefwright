import { describe, expect, it } from "vitest";

import type { SourceDefinition } from "../src/config/types.js";
import { connectorFor } from "../src/connectors/registry.js";
import { defineConnector, registerConnector, verifyConnectorContract } from "../src/connector-sdk.js";

describe("connector SDK", () => {
  it("validates, registers, contract-tests, and unregisters an extension", async () => {
    const source: SourceDefinition = { id: "SRC-EXT", title: "Extension", connector: { type: "extension", config: { adapter: "example", options: { allowedHosts: ["example.com"] } } } };
    const connector = defineConnector({
      descriptor: {
        type: "example", version: "1.0.0", title: "Example", requiresCredentials: false,
        capabilities: ["capture"], owner: "test", riskLabels: ["fixture"], authentication: { required: false, secretFields: [] },
        configSchema: { type: "object", required: ["allowedHosts"], properties: { allowedHosts: { type: "array", items: { type: "string" } } } },
        examples: [{ allowedHosts: ["example.com"] }],
      },
      async check() { return { ok: true, detail: "fixture" }; },
      async capture(input, context) { return [{ sourceId: input.id, externalKey: "1", canonicalUrl: "https://example.com/1", title: "Fixture", summary: "Fixture", capturedAt: context.now().toISOString(), contentHash: "abc", evidenceClass: "primary" as const }]; },
    });
    const unregister = registerConnector("example", connector);
    expect(connectorFor(source)).toBe(connector);
    await expect(verifyConnectorContract(connector, source, { fetch: async () => new Response(), now: () => new Date("2026-08-11T00:00:00Z") })).resolves.toEqual({ checked: true, captureCount: 1 });
    unregister();
    expect(() => connectorFor(source)).toThrow("not registered");
  });
});
