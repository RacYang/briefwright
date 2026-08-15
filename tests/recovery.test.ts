import { describe, expect, it } from "vitest";

import type { SourceDefinition } from "../src/config/types.js";
import { canonicalRecoveryHost, recoverCanonicalEvidence } from "../src/connectors/recovery.js";
import type { CaptureEnvelope } from "../src/connectors/types.js";

const capture: CaptureEnvelope = {
  sourceId: "SRC-ARXIV", externalKey: "2608.00001", canonicalUrl: "https://arxiv.org/abs/2608.00001",
  title: "Paper", summary: "Bounded abstract", capturedAt: "2026-08-12T00:00:00Z", contentHash: "hash", evidenceClass: "primary",
};
const source = { id: "SRC-ARXIV", title: "arXiv", domain: "基础", connector: { type: "rss", config: { url: "https://export.arxiv.org/rss/cs.AI" } } } as SourceDefinition;

describe("canonical evidence recovery", () => {
  it("creates a new observation instead of binding current canonical text to the historical hash", async () => {
    expect(canonicalRecoveryHost(source, capture)).toBe("arxiv.org");
    const recovered = await recoverCanonicalEvidence(source, capture, async () => new Response("<html><body>Original abstract evidence.</body></html>", { status: 200, headers: { "content-type": "text/html" } }), () => new Date("2026-08-13T00:00:00Z"));
    expect(recovered).toMatchObject({ analysisText: "Original abstract evidence.", summary: "Original abstract evidence.", capturedAt: "2026-08-13T00:00:00.000Z",
      recoveryOfContentHash: "hash", discoveryChannel: "canonical-recovery", parserVersion: "canonical-recovery-v2" });
    expect(recovered.contentHash).not.toBe("hash");
  });

  it("rejects a stored canonical URL outside the configured source boundary", () => {
    expect(() => canonicalRecoveryHost(source, { ...capture, canonicalUrl: "https://example.com/private" })).toThrow("outside the configured source domain");
  });
});
