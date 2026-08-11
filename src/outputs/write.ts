import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

import { prepareSafeFilePath } from "../config/paths.js";

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
  commit: () => T,
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
    const result = commit();
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
