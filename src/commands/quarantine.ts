import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadEffectiveConfig } from "../config/load.js";
import { assertSafeReadPath, prepareSafeFilePath } from "../config/paths.js";
import { SqliteStateStore } from "../state/sqlite.js";

type ArtifactPlan = {
  kind: string;
  originalPath: string;
  recordedHash: string;
  existed: boolean;
  observedHash: string | null;
  quarantinePath: string | null;
};

export interface LegacyQuarantineResult {
  runId: string;
  written: boolean;
  action: "abandon-zombie" | "quarantine-artifacts" | "none";
  reason: string;
  storedStatus: string;
  publicationState: string | null;
  artifacts: ArtifactPlan[];
  backupPath: string | null;
  manifestPath: string | null;
  stateAction: "abandoned" | "quarantined" | "unchanged" | null;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertWithinOutput(outputRoot: string, target: string): void {
  const root = path.resolve(outputRoot);
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes the configured document output: ${target}`);
  }
}

async function writeJsonAtomic(root: string, target: string, value: unknown): Promise<void> {
  await prepareSafeFilePath(root, target);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, target);
}

export async function quarantineLegacyRun(configPath: string, runId: string, options: {
  write?: boolean;
  yes?: boolean;
  reason?: string;
  now?: Date;
} = {}): Promise<LegacyQuarantineResult> {
  if (options.write && !options.yes) throw new Error("Writing a quarantine requires both --write and --yes");
  if (!/^RUN-[0-9]{8}-[A-Z0-9-]+(?:-R[0-9]{2})?$/.test(runId)) throw new Error(`Invalid formal run ID: ${runId}`);
  const config = await loadEffectiveConfig(configPath);
  await assertSafeReadPath(config.projectRoot, config.storage.path);
  await access(config.storage.path);
  const state = new SqliteStateStore(config.storage.path, config.projectRoot);
  try {
    const record = state.runRecord(runId);
    if (!record) throw new Error(`Run not found: ${runId}`);
    const recorded = state.runArtifacts(runId);
    if (record.result?.publicationState === "published") throw new Error(`Published run ${runId} cannot be quarantined`);
    if (["success", "empty"].includes(record.status)) throw new Error(`Terminal ${record.status} run ${runId} cannot be quarantined`);
    if (recorded.some((artifact) => !["daily-markdown", "review-markdown"].includes(artifact.kind))) {
      throw new Error(`Run ${runId} contains non-formal artifacts and cannot use legacy quarantine`);
    }
    if (recorded.length > 0 && !record.result) throw new Error(`Run ${runId} has artifacts but no result snapshot`);

    const reason = options.reason?.trim() || "Operator quarantined an incomplete legacy formal run";
    const action: LegacyQuarantineResult["action"] = !record.result && recorded.length === 0 && ["running", "finalizing"].includes(record.status)
      ? "abandon-zombie"
      : record.result && recorded.length > 0 && ["failed", "partial", "finalizing", "abandoned"].includes(record.status)
        ? "quarantine-artifacts"
        : record.result?.legacyQuarantine && recorded.length === 0
          ? "none"
        : record.status === "abandoned" && !record.result && recorded.length === 0
          ? "none"
          : (() => { throw new Error(`Run ${runId} has no safely quarantinable legacy state`); })();

    const artifacts: ArtifactPlan[] = [];
    for (const artifact of recorded) {
      assertWithinOutput(config.output.directory, artifact.path);
      await assertSafeReadPath(config.documents.root, artifact.path);
      let content: Uint8Array | null = null;
      try {
        const stats = await lstat(artifact.path);
        if (!stats.isFile()) throw new Error(`Recorded artifact is not a regular file: ${artifact.path}`);
        content = await readFile(artifact.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const observedHash = content ? digest(content) : null;
      if (observedHash && observedHash !== artifact.contentHash) {
        throw new Error(`Artifact hash mismatch for ${artifact.path}; refusing quarantine`);
      }
      artifacts.push({ kind: artifact.kind, originalPath: artifact.path, recordedHash: artifact.contentHash,
        existed: Boolean(content), observedHash, quarantinePath: null });
    }
    const preview: LegacyQuarantineResult = {
      runId, written: false, action, reason, storedStatus: record.status,
      publicationState: record.result?.publicationState ?? null, artifacts, backupPath: null,
      manifestPath: record.result?.legacyQuarantine?.manifestPath ?? null, stateAction: null,
    };
    if (!options.write || action === "none") return preview;

    const stamp = (options.now ?? new Date()).toISOString();
    const directoryName = `${stamp.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const quarantineDirectory = path.join(config.projectRoot, ".briefwright", "quarantine", runId, directoryName);
    const manifestPath = path.join(quarantineDirectory, "manifest.json");
    const backupPath = `${config.storage.path}.quarantine-backup-${stamp.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    for (const artifact of artifacts) {
      if (!artifact.existed) continue;
      artifact.quarantinePath = path.join(quarantineDirectory, `${artifact.kind}.md`);
      await prepareSafeFilePath(config.projectRoot, artifact.quarantinePath);
      await copyFile(artifact.originalPath, artifact.quarantinePath);
      const copiedHash = digest(await readFile(artifact.quarantinePath));
      if (copiedHash !== artifact.recordedHash) throw new Error(`Quarantine copy verification failed for ${artifact.originalPath}`);
    }
    const initialManifest = { version: 1, status: "prepared", runId, action, reason, preparedAt: stamp,
      databasePath: config.storage.path, backupPath, artifacts };
    await writeJsonAtomic(config.projectRoot, manifestPath, initialManifest);
    state.database.exec("PRAGMA wal_checkpoint(FULL)");
    await copyFile(config.storage.path, backupPath);
    await access(backupPath);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const integrity = backup.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
      if (integrity.integrity_check !== "ok") throw new Error(`SQLite backup integrity check failed: ${integrity.integrity_check}`);
    } finally {
      backup.close();
    }

    const removed: ArtifactPlan[] = [];
    try {
      for (const artifact of artifacts) {
        if (!artifact.existed) continue;
        await unlink(artifact.originalPath);
        removed.push(artifact);
      }
      const stateAction = state.quarantineLegacyRunState({ runId, now: stamp, reason, manifestPath,
        expectedArtifacts: recorded });
      const completed = { ...initialManifest, status: "complete", completedAt: new Date().toISOString(), stateAction };
      await writeJsonAtomic(config.projectRoot, manifestPath, completed);
      return { ...preview, written: true, backupPath, manifestPath, stateAction, artifacts };
    } catch (error) {
      for (const artifact of removed) {
        if (!artifact.quarantinePath) continue;
        await prepareSafeFilePath(config.output.directory, artifact.originalPath);
        await copyFile(artifact.quarantinePath, artifact.originalPath);
        if (digest(await readFile(artifact.originalPath)) !== artifact.recordedHash) {
          throw new Error(`Quarantine failed and restoration hash verification also failed for ${artifact.originalPath}`);
        }
      }
      throw error;
    }
  } finally {
    state.close();
  }
}
