import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rename, rm, writeFile } from "node:fs/promises";

import { prepareSafeFilePath } from "../config/paths.js";
import { RecoveryIncompleteError, type RecoveryPathObservation, type RecoveryPathRole } from "../errors.js";

export async function writeArtifactAtomic(projectRoot: string, outputPath: string, content: string): Promise<void> {
  await prepareSafeFilePath(projectRoot, outputPath);
  const temporaryPath = `${outputPath}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function writeArtifactSetAtomic<T>(
  projectRoot: string,
  artifacts: Array<{ path: string; content: string }>,
  commit: () => T | Promise<T>,
): Promise<T> {
  const token = randomUUID();
  const prepared: Array<{ path: string; temporary: string; backup: string; hadOriginal: boolean; installed: boolean }> = [];
  let committed = false;
  try {
    for (const artifact of artifacts) {
      await prepareSafeFilePath(projectRoot, artifact.path);
      const temporary = `${artifact.path}.tmp-${token}`;
      const backup = `${artifact.path}.backup-${token}`;
      await writeFile(temporary, artifact.content, { encoding: "utf8", flag: "wx" });
      prepared.push({ path: artifact.path, temporary, backup, hadOriginal: false, installed: false });
    }
    for (const item of prepared) {
      try { await rename(item.path, item.backup); item.hadOriginal = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(item.temporary, item.path);
      item.installed = true;
    }
    const result = await commit();
    committed = true;
    for (const item of prepared) if (item.hadOriginal) await rm(item.backup, { force: true }).catch(() => undefined);
    return result;
  } catch (error) {
    if (committed) throw error;
    for (const item of [...prepared].reverse()) {
      await rm(item.temporary, { force: true });
      if (item.installed) await rm(item.path, { force: true });
      if (item.hadOriginal) {
        try { await rename(item.backup, item.path); } catch {}
      }
    }
    throw error;
  }
}

function artifactHash(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function regularFileContent(pathname: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(pathname, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`Artifact target is not a regular file: ${pathname}`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function targetExists(pathname: string): Promise<boolean> {
  try {
    await lstat(pathname);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function observeRecoveryPath(role: RecoveryPathRole, pathname: string): Promise<RecoveryPathObservation> {
  try {
    const stats = await lstat(pathname);
    const observed = stats.isSymbolicLink()
      ? "symlink" as const
      : stats.isFile()
        ? "file" as const
        : stats.isDirectory()
          ? "directory" as const
          : "other" as const;
    return { role, path: pathname, observed, action: "PRESERVE" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { role, path: pathname, observed: "absent", action: "NONE" };
    }
    return { role, path: pathname, observed: "unreadable", action: "PRESERVE" };
  }
}

async function restoreWithoutClobber(backup: string, target: string): Promise<void> {
  if (await targetExists(target)) {
    throw new Error(`A competing target was preserved; the original preimage is retained at ${backup}`);
  }
  try {
    await link(backup, target);
    await rm(backup, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`A competing target was preserved; the original preimage is retained at ${backup}`);
    }
    throw error;
  }
}

async function rollbackConditionalInstall(input: {
  target: string;
  backup: string;
  displaced: string;
  desiredHash: string;
  hadOriginal: boolean;
  installed: boolean;
}): Promise<void> {
  if (!input.installed) {
    if (input.hadOriginal) await restoreWithoutClobber(input.backup, input.target);
    return;
  }

  let displaced = false;
  try {
    await rename(input.target, input.displaced);
    displaced = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (displaced) {
    const observed = await regularFileContent(input.displaced);
    if (observed !== undefined && artifactHash(observed) !== input.desiredHash) {
      try {
        await link(input.displaced, input.target);
        await rm(input.displaced, { force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Multiple competing target versions were preserved; inspect ${input.target}, ${input.displaced}, and ${input.backup}`);
        }
        throw error;
      }
      if (input.hadOriginal) {
        throw new Error(`A competing edit was preserved at ${input.target}; the original preimage is retained at ${input.backup}`);
      }
      return;
    }
    await rm(input.displaced, { force: true });
  }

  if (input.hadOriginal) await restoreWithoutClobber(input.backup, input.target);
}

/**
 * Installs one artifact only if the actual preimage still matches the reviewed
 * hash. The final link is no-clobber, so a file created after validation is
 * preserved and the durable callback is never invoked.
 */
export async function writeArtifactConditionalAtomic<T>(
  projectRoot: string,
  artifact: { path: string; content: string; expectedHash: string },
  commit: () => T | Promise<T>,
  preInstallGuard?: () => void | Promise<void>,
): Promise<{ result: T; cleanupWarnings: string[] }> {
  if (artifact.expectedHash !== "ABSENT" && !/^sha256:[a-f0-9]{64}$/.test(artifact.expectedHash)) {
    throw new Error("Conditional artifact writes require an exact sha256 preimage hash or ABSENT");
  }
  await prepareSafeFilePath(projectRoot, artifact.path);
  const token = randomUUID();
  const temporary = `${artifact.path}.tmp-${token}`;
  const backup = `${artifact.path}.backup-${token}`;
  const displaced = `${artifact.path}.displaced-${token}`;
  const desiredHash = artifactHash(artifact.content);
  let hadOriginal = false;
  let installed = false;
  let committed = false;

  try {
    await writeFile(temporary, artifact.content, { encoding: "utf8", flag: "wx" });
    if (artifact.expectedHash !== "ABSENT") {
      try {
        await rename(artifact.path, backup);
        hadOriginal = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error("Artifact target changed at install time: expected an existing preimage");
        }
        throw error;
      }
      const actual = await regularFileContent(backup);
      if (actual === undefined || artifactHash(actual) !== artifact.expectedHash) {
        throw new Error("Artifact target changed at install time: preimage hash mismatch");
      }
    }

    await preInstallGuard?.();
    try {
      await link(temporary, artifact.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Artifact target changed at install time: refusing to clobber a competing file");
      }
      throw error;
    }
    installed = true;
    await rm(temporary, { force: true });
    const result = await commit();
    committed = true;
    const cleanupWarnings: string[] = [];
    if (hadOriginal) {
      try {
        await rm(backup, { force: true });
      } catch (error) {
        cleanupWarnings.push(`Committed successfully, but the original backup could not be removed: ${backup} (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    return { result, cleanupWarnings };
  } catch (error) {
    const recoveryFailures: unknown[] = [];
    try {
      await rm(temporary, { force: true });
    } catch (recoveryError) {
      recoveryFailures.push(recoveryError);
    }
    if (!committed) {
      try {
        await rollbackConditionalInstall({
          target: artifact.path,
          backup,
          displaced,
          desiredHash,
          hadOriginal,
          installed,
        });
      } catch (recoveryError) {
        recoveryFailures.push(recoveryError);
      }
    }
    if (recoveryFailures.length > 0) {
      const paths = await Promise.all([
        observeRecoveryPath("target", artifact.path),
        observeRecoveryPath("backup", backup),
        observeRecoveryPath("displaced", displaced),
        observeRecoveryPath("temporary", temporary),
      ]);
      throw new RecoveryIncompleteError(paths, { cause: new AggregateError([error, ...recoveryFailures]) });
    }
    throw error;
  }
}
