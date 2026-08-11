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

  it("rejects malformed deep policy and connector fields during configuration loading", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-advanced-invalid-"));
    const configPath = await initializeProject({ directory: root, yes: true });
    await ejectConfiguration(configPath);
    const sourcePath = path.join(root, "briefwright.d/sources/src-qwen-code-releases.yaml");
    const source = parse(await readFile(sourcePath, "utf8")) as { spec: { connector: { config: Record<string, unknown> } } };
    source.spec.connector.config = { typo: "QwenLM/qwen-code" };
    await writeFile(sourcePath, stringify(source), "utf8");
    await expect(loadEffectiveConfig(configPath)).rejects.toThrow("Invalid advanced resource");

    const policyPath = path.join(root, "briefwright.d/policy.yaml");
    const policy = parse(await readFile(policyPath, "utf8")) as { spec: Record<string, unknown> };
    policy.spec.unknownPolicyField = true;
    await writeFile(policyPath, stringify(policy), "utf8");
    await expect(loadEffectiveConfig(configPath)).rejects.toThrow("Invalid advanced resource");
  });

  it("accepts regional inference endpoints and rejects interactive-only Coding Plan endpoints", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-regional-provider-"));
    const configPath = await initializeProject({ directory: root, yes: true });
    await ejectConfiguration(configPath);
    const profilePath = path.join(root, "briefwright.d/profile.yaml");
    const profile = parse(await readFile(profilePath, "utf8")) as { spec: { provider: { baseUrl: string } } };
    profile.spec.provider.baseUrl = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
    await writeFile(profilePath, stringify(profile), "utf8");
    await expect(loadEffectiveConfig(configPath)).resolves.toMatchObject({ provider: { baseUrl: profile.spec.provider.baseUrl } });
    profile.spec.provider.baseUrl = "https://coding.dashscope.aliyuncs.com/v1";
    await writeFile(profilePath, stringify(profile), "utf8");
    await expect(loadEffectiveConfig(configPath)).rejects.toMatchObject({ problems: [expect.stringContaining("pay-as-you-go or trial")] });
  });
});
