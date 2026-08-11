import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { installSkill, skillStatus } from "../src/commands/skill.js";

describe("conversational Skill installation", () => {
  it("installs a managed Skill, reports integrity, and safely updates it", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "briefwright-skill-")));
    const destination = path.join(root, "briefwright");
    await expect(installSkill({ destination, yes: false, version: "test" })).rejects.toThrow("confirm with --yes");

    const installed = await installSkill({ destination, yes: true, version: "2.0.1" });
    expect(installed.updated).toBe(false);
    expect(await skillStatus(destination)).toMatchObject({ installed: true, managed: true, intact: true, version: "2.0.1" });
    expect(await readFile(path.join(destination, "SKILL.md"), "utf8")).toContain("Conversational onboarding");

    const updated = await installSkill({ destination, yes: true, version: "2.0.2" });
    expect(updated.updated).toBe(true);
    expect(await skillStatus(destination)).toMatchObject({ intact: true, version: "2.0.2" });
  });

  it("refuses to overwrite unmanaged or locally modified Skill files", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "briefwright-skill-")));
    const unmanaged = path.join(root, "unmanaged");
    await writeFile(unmanaged, "occupied");
    await expect(installSkill({ destination: unmanaged, yes: true, version: "test" })).rejects.toThrow();

    const managed = path.join(root, "managed");
    await installSkill({ destination: managed, yes: true, version: "test" });
    await writeFile(path.join(managed, "SKILL.md"), "local edit\n");
    await expect(installSkill({ destination: managed, yes: true, version: "next" })).rejects.toThrow("locally modified");

    const forged = path.join(root, "forged");
    await mkdir(forged);
    await writeFile(path.join(forged, ".briefwright-managed.json"), JSON.stringify({ manager: "briefwright", version: "fake", files: { "../../outside": "0".repeat(64) } }));
    expect(await skillStatus(forged)).toMatchObject({ installed: true, managed: false });
    await expect(installSkill({ destination: forged, yes: true, version: "next" })).rejects.toThrow("unmanaged");
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked destination component", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "briefwright-skill-")));
    const outside = path.join(root, "outside");
    const linked = path.join(root, "linked");
    await mkdir(outside);
    await symlink(outside, linked);
    await expect(installSkill({ destination: path.join(linked, "briefwright"), yes: true, version: "test" })).rejects.toThrow("may not use symlinks");
  });

  it("keeps the Skill contract conversational and provider-neutral", async () => {
    const text = await readFile(path.resolve("skill/briefwright/SKILL.md"), "utf8");
    for (const phrase of [
      "npm install -g briefwright",
      "Codex, OpenAI, Anthropic, Gemini, Qwen, Ollama",
      "Feishu Base",
      "SQLite",
      "Obsidian",
      "normal local folder",
      "explicit confirmation",
      "14-day and 50-reviewed-item gate",
      "ordinary user to learn commands",
    ]) expect(text).toContain(phrase);
  });
});
