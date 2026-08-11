import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const cli = path.join(root, "src/cli.ts");

async function command(args: string[]) {
  const result = await execute(process.execPath, [tsx, cli, "--json", ...args], { cwd: root });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("CLI golden path", () => {
  it("initializes, validates, previews, replays, and reports status using stable JSON", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "briefwright-cli-"));
    const initialized = await command(["init", "--directory", project, "--yes"]);
    expect(initialized).toMatchObject({ ok: true, command: "init", scheduleEnabled: false });
    const configPath = String(initialized.configPath);
    await expect(command(["config", "validate", "--config", configPath])).resolves.toMatchObject({ ok: true });
    const preview = await command(["preview", "--config", configPath]);
    expect(preview).toMatchObject({ ok: true, command: "preview", mode: "fixture", scheduleEnabled: false });
    const status = await command(["status", "--config", configPath]);
    expect(status).toMatchObject({ ok: true, scheduleEnabled: false, latestRun: { runId: expect.any(String) } });
    await expect(command(["replay", String((status.latestRun as { runId: string }).runId), "--config", configPath])).resolves.toMatchObject({ ok: true, matches: true });
  }, 15_000);

  it("describes schedules without installing and rejects manual schedules", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "briefwright-cli-schedule-"));
    const initialized = await command(["init", "--directory", project, "--yes"]);
    try {
      await command(["schedule", "describe", "--platform", "linux", "--config", String(initialized.configPath)]);
      throw new Error("manual schedule unexpectedly succeeded");
    } catch (error) {
      const output = JSON.parse(String((error as { stdout?: string }).stdout)) as { ok: boolean; error: { message: string } };
      expect(output.ok).toBe(false);
      expect(output.error.message).toContain("Schedule is manual");
    }
  }, 15_000);
});
