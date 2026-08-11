import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { ejectConfiguration } from "../src/commands/config.js";
import { initializeProject } from "../src/commands/init.js";
import { loadEffectiveConfig } from "../src/config/load.js";

describe("advanced configuration", () => {
  it("is absent by default and takes effect only after explicit eject", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-advanced-"));
    const configPath = await initializeProject({ directory: root, yes: true });
    const before = await loadEffectiveConfig(configPath);
    expect(before.runtime.modelConcurrency).toBe(2);
    const files = await ejectConfiguration(configPath);
    expect(files.length).toBeGreaterThan(4);
    const profilePath = path.join(root, "briefwright.d/profile.yaml");
    const profile = parse(await readFile(profilePath, "utf8")) as { spec: { runtime: { modelConcurrency: number } } };
    profile.spec.runtime.modelConcurrency = 1;
    await writeFile(profilePath, stringify(profile), "utf8");
    const after = await loadEffectiveConfig(configPath);
    expect(after.runtime.modelConcurrency).toBe(1);
    expect(after.origins.runtime).toBe(profilePath);
    await expect(ejectConfiguration(configPath)).rejects.toThrow("already exists");
  });
});
