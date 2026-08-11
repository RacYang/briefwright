import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/commands/init.js";
import { loadEffectiveConfig } from "../src/config/load.js";
import { loadExternalCaptureBundle } from "../src/connectors/external-bundle.js";

describe("validated external browser captures", () => {
  it("binds status URLs to the configured source and treats browser text as secondary evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-external-"));
    const configPath = await initializeProject({ directory: root, yes: true, model: "codex" });
    const config = await loadEffectiveConfig(configPath);
    config.preset.sources = [{ id: "SRC-OPENAI-X", title: "OpenAI X", connector: { type: "codex-browser", config: { username: "OpenAI" } } }];
    const inbox = path.join(root, ".briefwright/inbox"); await mkdir(inbox, { recursive: true }); const bundle = path.join(inbox, "x.json");
    await writeFile(bundle, JSON.stringify({ apiVersion: "briefwright.dev/external-captures/v1", generatedAt: "2026-08-11T02:00:00Z", sources: [{ sourceId: "SRC-OPENAI-X", status: "captured",
      captures: [{ url: "https://x.com/OpenAI/status/123", title: "Release", text: "A source-linked release announcement.", publishedAt: "2026-08-11T01:00:00Z" }] }] }));
    const loaded = await loadExternalCaptureBundle(config, bundle, new Date("2026-08-11T03:00:00Z"));
    expect(loaded.get("SRC-OPENAI-X")?.captures).toMatchObject([{ canonicalUrl: "https://x.com/OpenAI/status/123", evidenceClass: "secondary", discoveryChannel: "codex-browser" }]);
    await writeFile(bundle, JSON.stringify({ apiVersion: "briefwright.dev/external-captures/v1", generatedAt: "2026-08-11T02:00:00Z", sources: [{ sourceId: "SRC-OPENAI-X", status: "captured",
      captures: [{ url: "https://x.com/Other/status/123", title: "Wrong", text: "Wrong account" }] }] }));
    await expect(loadExternalCaptureBundle(config, bundle, new Date("2026-08-11T03:00:00Z"))).rejects.toThrow("does not match @OpenAI");
  });
});
