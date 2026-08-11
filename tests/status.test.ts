import { access, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/commands/init.js";
import { latestArtifactPath } from "../src/commands/open.js";
import { previewProject } from "../src/commands/preview.js";
import { verifyReplay } from "../src/commands/replay.js";
import { projectStatus } from "../src/commands/status.js";

describe("project status", () => {
  it("is empty before preview and reports the latest artifact afterwards", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-status-"));
    const configPath = await initializeProject({ directory: root, yes: true });

    const before = await projectStatus(configPath);
    expect(before.scheduleEnabled).toBe(false);
    expect(before.latestRun).toBeNull();
    await expect(latestArtifactPath(configPath)).rejects.toThrow("Run 'briefwright preview'");

    const preview = await previewProject(configPath);
    const after = await projectStatus(configPath);
    expect(after.latestRun).toMatchObject({
      mode: "fixture",
      status: "success",
      artifactPath: preview.outputPath,
      failed: 0,
    });
    await expect(latestArtifactPath(configPath)).resolves.toBe(preview.outputPath);
    await expect(verifyReplay(configPath, after.latestRun!.runId)).resolves.toMatchObject({
      matches: true,
      snapshotMatches: true,
      diskMatches: true,
      artifactPath: preview.outputPath,
    });

    await writeFile(preview.outputPath, "tampered", "utf8");
    await expect(verifyReplay(configPath, after.latestRun!.runId)).resolves.toMatchObject({
      matches: false,
      snapshotMatches: true,
      diskMatches: false,
    });

    const changed = (await readFile(configPath, "utf8")).replace("My AI briefing", "Changed briefing");
    await writeFile(configPath, changed, "utf8");
    await expect(previewProject(configPath)).resolves.toMatchObject({ mode: "fixture" });
  });

  it("refuses symlinked state and output paths", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "briefwright-state-link-"));
    const outsideState = await mkdtemp(path.join(tmpdir(), "briefwright-outside-state-"));
    const stateConfig = await initializeProject({ directory: stateRoot, yes: true });
    await symlink(outsideState, path.join(stateRoot, ".briefwright"));
    await expect(previewProject(stateConfig)).rejects.toThrow("symlink");
    await expect(access(path.join(outsideState, "state.db"))).rejects.toThrow();

    const outputRoot = await mkdtemp(path.join(tmpdir(), "briefwright-output-link-"));
    const outsideOutput = await mkdtemp(path.join(tmpdir(), "briefwright-outside-output-"));
    const outputConfig = await initializeProject({ directory: outputRoot, yes: true });
    await mkdir(path.join(outputRoot, ".briefwright"));
    await symlink(outsideOutput, path.join(outputRoot, ".briefwright", "previews"));
    await expect(previewProject(outputConfig)).rejects.toThrow("symlink");
    await expect(readdir(outsideOutput)).resolves.toEqual([]);
  });
});
