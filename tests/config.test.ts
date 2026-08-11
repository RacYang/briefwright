import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  ConfigurationError,
  configDigest,
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
