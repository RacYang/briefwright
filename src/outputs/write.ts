import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function writeArtifactAtomic(outputPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, content, { encoding: "utf8", flag: "w" });
  await rename(temporaryPath, outputPath);
}

