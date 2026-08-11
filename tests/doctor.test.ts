import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/commands/init.js";
import { runDoctor } from "../src/commands/doctor.js";

describe("doctor diagnostics", () => {
  it("validates a fresh project without creating output or state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-doctor-"));
    const configPath = await initializeProject({ directory: root, yes: true });
    const checks = await runDoctor(configPath);
    expect(checks.every((check) => check.ok)).toBe(true);
    await expect(access(path.join(root, "briefs"))).rejects.toThrow();
    await expect(access(path.join(root, ".briefwright"))).rejects.toThrow();
  });

  it("rejects an existing output target that is a regular file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-doctor-file-"));
    const configPath = await initializeProject({ directory: root, yes: true });
    await writeFile(path.join(root, "briefs"), "not a directory", "utf8");
    const checks = await runDoctor(configPath);
    expect(checks.find((check) => check.name === "output-boundary")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("not a directory"),
    });
  });
});
