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
