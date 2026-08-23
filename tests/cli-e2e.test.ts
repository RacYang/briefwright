import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { access, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/commands/init.js";
import { runFormalProject } from "../src/core/run.js";
import { FixtureModelProvider } from "../src/providers/fixture.js";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const tsx = path.join(root, "node_modules/tsx/dist/cli.mjs");
const cli = path.join(root, "src/cli.ts");

async function command(args: string[]) {
  const result = await execute(process.execPath, [tsx, cli, "--json", ...args], { cwd: root });
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function rowCount(databasePath: string, table: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Number((database.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count);
  } finally {
    database.close();
  }
}

function response(url: string): Response {
  if (url.includes("github")) return new Response(JSON.stringify([{
    id: 1,
    html_url: "https://github.com/QwenLM/qwen-code/releases/tag/v1",
    name: "AI agents runtime",
    tag_name: "v1",
    body: "AI agents runtime adds tool budgets",
    published_at: "2026-08-11T00:00:00Z",
    draft: false,
    prerelease: false,
  }]), { status: 200 });
  return new Response("<rss><channel></channel></rss>", { status: 200 });
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
  }, 30_000);

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
  }, 30_000);

  it("reuses a proposal request and exposes a zero-write knowledge readback", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "briefwright-cli-knowledge-"));
    const configPath = await initializeProject({ directory: project, yes: true, interests: ["AI agents"] });
    const run = await runFormalProject(configPath, {
      now: new Date("2026-08-11T02:00:00Z"),
      provider: new FixtureModelProvider(),
      fetch: async (url) => response(String(url)),
    });
    const item = run.result.daily[0]!;
    const resolved = await command(["knowledge", "resolve", "--item-id", item.id, "--run", run.runId, "--config", configPath]);
    const selected = await command([
      "knowledge", "select", "--item-id", item.id, "--run", run.runId,
      "--expect-selection", String(resolved.selectionDigest), "--yes", "--config", configPath,
    ]);
    const requestId = randomUUID();
    const proposed = await command([
      "knowledge", "propose", String(selected.selectionId), "--request-id", requestId,
      "--target", "knowledge/agents.md", "--config", configPath,
    ]);
    expect(proposed).toMatchObject({ ok: true, status: "PROPOSED", requestId, proposalWrites: 1, knowledgeTargetWrites: 0 });
    const databasePath = path.join(project, ".briefwright", "state.db");
    const previewPath = String(proposed.previewPath);
    const targetPath = String(proposed.targetPath);
    const proposalFilesBeforeReadback = await readdir(path.dirname(previewPath));
    const previewBeforeReadback = await readFile(previewPath, "utf8");
    const proposalRowsBeforeReadback = rowCount(databasePath, "knowledge_proposals");
    const receiptRowsBeforeReadback = rowCount(databasePath, "knowledge_commit_receipts");

    const replayed = await command([
      "knowledge", "propose", String(selected.selectionId), "--request-id", requestId.toUpperCase(),
      "--target", "knowledge/agents.md", "--config", configPath,
    ]);
    expect(replayed).toMatchObject({
      ok: true,
      status: "READBACK",
      proposalId: proposed.proposalId,
      operation: proposed.operation,
      diff: proposed.diff,
      expectedTargetHash: proposed.expectedTargetHash,
      resultingContentHash: proposed.resultingContentHash,
      vaultScanDigest: proposed.vaultScanDigest,
      expectedPostScanDigest: proposed.expectedPostScanDigest,
      proposalWrites: 0,
      knowledgeTargetWrites: 0,
      selectionConfirmation: { status: "CONSUMED" },
      commitConfirmation: { status: "REQUIRED" },
    });

    await expect(command(["knowledge", "readback", "--request-id", requestId, "--config", configPath]))
      .resolves.toMatchObject({
        ok: true,
        command: "knowledge readback",
        status: "READBACK",
        proposalId: proposed.proposalId,
        previewReadback: { status: "MATCH" },
        targetReadback: { status: "MATCH" },
        writes: 0,
      });
    expect(rowCount(databasePath, "knowledge_proposals")).toBe(proposalRowsBeforeReadback);
    expect(rowCount(databasePath, "knowledge_commit_receipts")).toBe(receiptRowsBeforeReadback);
    expect(await readdir(path.dirname(previewPath))).toEqual(proposalFilesBeforeReadback);
    expect(await readFile(previewPath, "utf8")).toBe(previewBeforeReadback);
    await expect(access(targetPath)).rejects.toThrow();
  }, 60_000);
});
