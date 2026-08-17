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
    await expect(loadExternalCaptureBundle(config, bundle, new Date("2026-08-14T03:00:00Z"))).rejects.toThrow("within the last 48 hours");
    await expect(loadExternalCaptureBundle(config, bundle, new Date("2026-08-14T03:00:00Z"), { allowStale: true })).resolves.toBeInstanceOf(Map);
    await writeFile(bundle, JSON.stringify({ apiVersion: "briefwright.dev/external-captures/v1", generatedAt: "2026-08-11T02:00:00Z", sources: [{ sourceId: "SRC-OPENAI-X", status: "captured",
      captures: [{ url: "https://x.com/Other/status/123", title: "Wrong", text: "Wrong account" }] }] }));
    await expect(loadExternalCaptureBundle(config, bundle, new Date("2026-08-11T03:00:00Z"))).rejects.toThrow("does not match @OpenAI");
  });

  it("accepts host-bound Computer Use observations and rejects mode or host substitution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-computer-use-"));
    const configPath = await initializeProject({ directory: root, yes: true, model: "codex" });
    const config = await loadEffectiveConfig(configPath);
    config.preset.sources = [{
      id: "SRC-DYNAMIC-DOCS",
      title: "Dynamic official docs",
      evidenceTier: "primary",
      connector: { type: "computer-use", config: { url: "https://docs.example.com/releases", allowedHosts: ["docs.example.com"] } },
    }];
    const inbox = path.join(root, ".briefwright/inbox");
    await mkdir(inbox, { recursive: true });
    const bundle = path.join(inbox, "computer-use.json");
    const longText = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    const valid = { apiVersion: "briefwright.dev/external-captures/v1", generatedAt: "2026-08-11T02:00:00Z", sources: [{
      sourceId: "SRC-DYNAMIC-DOCS", status: "captured", captureMode: "computer-use",
      captures: [{ url: "https://docs.example.com/releases/agent-v2#overview", title: "Agent v2", text: longText, publishedAt: "2026-08-11T01:00:00Z", dateKind: "event" as const }],
    }] };
    await writeFile(bundle, JSON.stringify(valid));
    const loaded = await loadExternalCaptureBundle(config, bundle, new Date("2026-08-11T03:00:00Z"));
    expect(loaded.get("SRC-DYNAMIC-DOCS")?.captures).toMatchObject([{
      canonicalUrl: "https://docs.example.com/releases/agent-v2",
      evidenceClass: "primary",
      discoveryChannel: "computer-use",
      parserVersion: "computer-use-bundle-v1",
      publishedAt: "2026-08-11T01:00:00.000Z",
    }]);
    expect(loaded.get("SRC-DYNAMIC-DOCS")?.captures[0]?.summary.split(" ")).toHaveLength(25);
    expect(loaded.get("SRC-DYNAMIC-DOCS")?.captures[0]?.analysisText).toContain("word39");

    const pageUpdated = { ...valid, sources: [{ ...valid.sources[0], captures: [{ ...valid.sources[0]!.captures[0], dateKind: "page-updated" as const }] }] };
    await writeFile(bundle, JSON.stringify(pageUpdated));
    const pageLoaded = await loadExternalCaptureBundle(config, bundle, new Date("2026-08-11T03:00:00Z"));
    expect(pageLoaded.get("SRC-DYNAMIC-DOCS")?.captures).toMatchObject([{
      pageUpdatedAt: "2026-08-11T01:00:00.000Z",
    }]);
    expect(pageLoaded.get("SRC-DYNAMIC-DOCS")?.captures[0]?.publishedAt).toBeUndefined();

    await writeFile(bundle, JSON.stringify({ ...valid, sources: [{ ...valid.sources[0], captures: [{ ...valid.sources[0]!.captures[0], dateKind: undefined }] }] }));
    await expect(loadExternalCaptureBundle(config, bundle, new Date("2026-08-11T03:00:00Z"))).rejects.toThrow("must declare dateKind");

    await writeFile(bundle, JSON.stringify({ ...valid, sources: [{ ...valid.sources[0], captureMode: undefined }] }));
    await expect(loadExternalCaptureBundle(config, bundle, new Date("2026-08-11T03:00:00Z"))).rejects.toThrow("must declare captureMode computer-use");
    await writeFile(bundle, JSON.stringify({ ...valid, sources: [{ ...valid.sources[0], captures: [{ ...valid.sources[0]!.captures[0], url: "https://evil.example/releases/agent-v2" }] }] }));
    await expect(loadExternalCaptureBundle(config, bundle, new Date("2026-08-11T03:00:00Z"))).rejects.toThrow("is not allowed");
  });

  it("accepts isolated in-app Browser observations without relabeling them as Computer Use", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-in-app-browser-"));
    const configPath = await initializeProject({ directory: root, yes: true, model: "codex" });
    const config = await loadEffectiveConfig(configPath);
    config.preset.sources = [{ id: "SRC-DYNAMIC-WEB", title: "Dynamic web", evidenceTier: "primary",
      connector: { type: "in-app-browser", config: { url: "https://news.example.com/ai", allowedHosts: ["news.example.com"] } } }];
    const inbox = path.join(root, ".briefwright/inbox"); await mkdir(inbox, { recursive: true });
    const bundle = path.join(inbox, "browser.json");
    const valid = { apiVersion: "briefwright.dev/external-captures/v1", generatedAt: "2026-08-11T02:00:00Z", sources: [{
      sourceId: "SRC-DYNAMIC-WEB", status: "captured", captureMode: "in-app-browser",
      captures: [{ url: "https://news.example.com/ai/release", title: "Release", text: "A primary release page.", publishedAt: "2026-08-11T01:00:00Z", dateKind: "event" }],
    }] };
    await writeFile(bundle, JSON.stringify(valid));
    const loaded = await loadExternalCaptureBundle(config, bundle, new Date("2026-08-11T03:00:00Z"));
    expect(loaded.get("SRC-DYNAMIC-WEB")?.captures).toMatchObject([{ discoveryChannel: "in-app-browser", parserVersion: "in-app-browser-bundle-v1", evidenceClass: "primary" }]);
    await writeFile(bundle, JSON.stringify({ ...valid, sources: [{ ...valid.sources[0], captureMode: "computer-use" }] }));
    await expect(loadExternalCaptureBundle(config, bundle, new Date("2026-08-11T03:00:00Z"))).rejects.toThrow("must declare captureMode in-app-browser");
  });
});
