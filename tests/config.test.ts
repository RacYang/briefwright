import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  ConfigurationError,
  configDigest,
  executionConfigProjection,
  loadEffectiveConfig,
  parseIntent,
} from "../src/config/load.js";
import { resolveWithinRoot } from "../src/config/paths.js";
import { resolveSecret } from "../src/config/secrets.js";

async function temporaryProject(config: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "briefwright-config-"));
  await mkdir(root, { recursive: true });
  const configPath = path.join(root, "briefing.yaml");
  await writeFile(configPath, config, "utf8");
  return configPath;
}

describe("intent configuration", () => {
  it("expands safe defaults explicitly", async () => {
    const configPath = await temporaryProject(`
version: 1
name: Test briefing
interests:
  - AI agents
`);

    const intent = await parseIntent(configPath);
    expect(intent.preset).toBe("ai-daily");
    expect(intent.schedule).toBe("manual");
    expect(intent.outputDirectory).toBe("briefs");
  });

  it("rejects unknown fields instead of silently ignoring them", async () => {
    const configPath = await temporaryProject(`
version: 1
name: Test briefing
interests: [AI agents]
scroe: 70
`);

    await expect(parseIntent(configPath)).rejects.toMatchObject<Partial<ConfigurationError>>({
      name: "ConfigurationError",
      problems: [expect.stringContaining("unknown field 'scroe'")],
    });
  });

  it("resolves output and state inside the project", async () => {
    const configPath = await temporaryProject(`
version: 1
name: Test briefing
interests: [AI agents]
`);
    const config = await loadEffectiveConfig(configPath);
    expect(config.output.directory).toBe(path.join(path.dirname(configPath), "briefs"));
    expect(config.storage.path).toBe(path.join(path.dirname(configPath), ".briefwright/state.db"));
  });
});

describe("configuration integrity", () => {
  it("binds a compatible source contract by digest and rejects later changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-source-contract-"));
    const configPath = path.join(root, "briefing.yaml");
    await writeFile(configPath, "version: 3\nname: Bound\ninterests: [AI agents]\nmodel: qwen\nprocessStore: sqlite\ndocumentStore: local\n", "utf8");
    const baseline = await loadEffectiveConfig(configPath);
    const contractPath = path.join(root, "source-contract.json");
    const contract = {
      contract_id: baseline.protocol.contractId,
      identity_contract: { active_rules: baseline.policy.rules.map((rule) => ({ rule_id: rule.id })) },
      systems: { obsidian_root: baseline.documents.root, tables: {} },
      obsidian_outputs: {
        daily_path: "Inbox/AI Intelligence/Daily/YYYY-MM-DD-AI情报简报.md",
        review_path: "Inbox/AI Intelligence/Review/YYYY-MM-DD-AI情报待复核.md",
        forbidden_writes: [],
      },
      run_contract: {}, due_manifest: {}, capture_contract: {}, feedback_and_improvement: {}, completion_report: {},
    };
    const text = JSON.stringify(contract);
    const digest = createHash("sha256").update(text).digest("hex");
    await writeFile(contractPath, text, "utf8");
    await writeFile(configPath, `version: 3\nname: Bound\ninterests: [AI agents]\nmodel: qwen\nprocessStore: sqlite\ndocumentStore: local\nsourceContract:\n  path: ${JSON.stringify(contractPath)}\n  sha256: ${digest}\n`, "utf8");

    await expect(loadEffectiveConfig(configPath)).resolves.toMatchObject({ sourceContract: { path: contractPath, sha256: digest } });
    await writeFile(contractPath, `${text}\n`, "utf8");
    await expect(loadEffectiveConfig(configPath)).rejects.toThrow("digest does not match");
  });

  it("rejects absolute and escaping output paths", () => {
    expect(() => resolveWithinRoot("/tmp/project", "/tmp/outside")).toThrow("must be relative");
    expect(() => resolveWithinRoot("/tmp/project", "../outside")).toThrow("escapes the project");
  });

  it("canonicalizes object key order before hashing", async () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    const configPath = await temporaryProject(`
version: 1
name: Test briefing
interests: [AI agents]
`);
    const config = await loadEffectiveConfig(configPath);
    expect(configDigest(config)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("excludes only derived source timing state from the execution digest", async () => {
    const configPath = await temporaryProject(`
version: 3
name: Digest projection
interests: [AI agents]
model: qwen
processStore: sqlite
documentStore: local
`);
    const config = await loadEffectiveConfig(configPath);
    const withTiming = structuredClone(config);
    withTiming.preset.sources[0]!.scheduleState = {
      frequency: "daily", humanLocked: true, lastScanAt: "2026-08-12T00:00:00Z",
      lastSuccessAt: "2026-08-12T00:00:01Z", lastEffectiveUpdateAt: "2026-08-12T00:00:02Z",
      nextScanAt: "2026-08-13T00:00:00Z",
    };
    const timingDrift = structuredClone(withTiming);
    timingDrift.preset.sources[0]!.scheduleState = {
      ...timingDrift.preset.sources[0]!.scheduleState,
      lastScanAt: "2026-08-13T00:00:00Z", nextScanAt: "2026-08-14T00:00:00Z",
    };
    timingDrift.provenance.controlPlaneRevision = "remote-revision-2";
    expect(configDigest(timingDrift)).toBe(configDigest(withTiming));
    expect(executionConfigProjection(timingDrift).preset.sources[0]!.scheduleState).toEqual({ frequency: "daily", humanLocked: true });

    for (const mutate of [
      (candidate: typeof withTiming) => { candidate.preset.sources[0]!.connector = { type: "rss", config: { url: "https://example.com/feed.xml" } }; },
      (candidate: typeof withTiming) => { candidate.preset.sources[0]!.cadence = { minimumHours: 1, defaultHours: 2, maximumHours: 3 }; },
      (candidate: typeof withTiming) => { candidate.preset.sources[0]!.scheduleState!.humanLocked = false; },
      (candidate: typeof withTiming) => { candidate.policy.rules[0]!.version = "changed"; },
      (candidate: typeof withTiming) => { candidate.provider.model = "changed-model"; },
      (candidate: typeof withTiming) => { candidate.runtime.timeoutSeconds += 1; },
    ]) {
      const changed = structuredClone(withTiming); mutate(changed);
      expect(configDigest(changed)).not.toBe(configDigest(withTiming));
    }
  });

  it("refuses configuration and secret reads through project symlinks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-read-boundary-"));
    const outside = await mkdtemp(path.join(tmpdir(), "briefwright-read-outside-"));
    const outsideConfig = path.join(outside, "briefing.yaml");
    await writeFile(outsideConfig, "version: 2\nname: Outside\ninterests: [AI agents]\n", "utf8");
    const linkedConfig = path.join(root, "briefing.yaml");
    await symlink(outsideConfig, linkedConfig);
    await expect(loadEffectiveConfig(linkedConfig)).rejects.toThrow("symlink");

    await writeFile(path.join(outside, "secret"), "do-not-follow", "utf8");
    await symlink(path.join(outside, "secret"), path.join(root, "secret"));
    await expect(resolveSecret({ provider: "file", key: "secret" }, root)).rejects.toThrow("symlink");
  });
});
