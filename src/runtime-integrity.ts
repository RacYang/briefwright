import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function digestRoot(): { root: string; includeNodeModules: boolean } {
  const packageDirectory = packageRoot();
  const parent = path.dirname(packageDirectory);
  if (path.basename(parent) === "node_modules") return { root: path.dirname(parent), includeNodeModules: true };
  return { root: packageDirectory, includeNodeModules: false };
}

async function filesUnder(root: string, includeNodeModules: boolean): Promise<Array<{ path: string; link?: string }>> {
  const files: Array<{ path: string; link?: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || (!includeNodeModules && entry.name === "node_modules")) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isSymbolicLink()) files.push({ path: absolute, link: await readlink(absolute) });
      else if (entry.isFile()) files.push({ path: absolute });
      else if ((await lstat(absolute)).isFile()) files.push({ path: absolute });
    }
  };
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

/** Content digest for the exact installed runtime tree used by automation. */
export async function runtimeTreeDigest(): Promise<string> {
  const { root, includeNodeModules } = digestRoot();
  const hash = createHash("sha256");
  for (const file of await filesUnder(root, includeNodeModules)) {
    const relative = path.relative(root, file.path).split(path.sep).join("/");
    hash.update(relative).update("\0");
    if (file.link !== undefined) hash.update("link\0").update(file.link);
    else hash.update(await readFile(file.path));
    hash.update("\0");
  }
  return hash.digest("hex");
}
