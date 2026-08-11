import path from "node:path";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";

export function resolveWithinRoot(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Output directory must be relative to the project: ${relativePath}`);
  }

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const prefix = `${resolvedRoot}${path.sep}`;

  if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
    throw new Error(`Output directory escapes the project: ${relativePath}`);
  }

  return resolved;
}

function assertContained(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const prefix = `${resolvedRoot}${path.sep}`;
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(prefix)) {
    throw new Error(`Path escapes the project: ${target}`);
  }
  return resolvedTarget;
}

function relativeParents(root: string, target: string): string[] {
  const parent = path.dirname(assertContained(root, target));
  const relative = path.relative(path.resolve(root), parent);
  return relative ? relative.split(path.sep) : [];
}

/** Validate an existing read path without creating files or following symlinks below the project root. */
export async function assertSafeReadPath(root: string, target: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = assertContained(resolvedRoot, target);
  const realRoot = await realpath(resolvedRoot);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  let current = resolvedRoot;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new Error(`Read path may not use a symlink: ${current}`);
      if (current !== resolvedTarget && !stats.isDirectory()) throw new Error(`Read path component is not a directory: ${current}`);
      assertContained(realRoot, await realpath(current));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

/** Prepare a parent directory without following symlinks below the project root. */
export async function prepareSafeFilePath(root: string, target: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  await mkdir(resolvedRoot, { recursive: true });
  const realRoot = await realpath(resolvedRoot);
  let current = resolvedRoot;

  for (const segment of relativeParents(resolvedRoot, target)) {
    current = path.join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) throw new Error(`Path uses a symlink outside the trusted project tree: ${current}`);
      if (!stats.isDirectory()) throw new Error(`Path component is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
    assertContained(realRoot, await realpath(current));
  }

  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) throw new Error(`Target may not be a symlink: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Synchronous variant for Node's synchronous SQLite API. */
export function prepareSafeFilePathSync(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  mkdirSync(resolvedRoot, { recursive: true });
  const realRoot = realpathSync(resolvedRoot);
  let current = resolvedRoot;

  for (const segment of relativeParents(resolvedRoot, target)) {
    current = path.join(current, segment);
    try {
      const stats = lstatSync(current);
      if (stats.isSymbolicLink()) throw new Error(`Path uses a symlink outside the trusted project tree: ${current}`);
      if (!stats.isDirectory()) throw new Error(`Path component is not a directory: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current);
    }
    assertContained(realRoot, realpathSync(current));
  }

  try {
    const stats = lstatSync(target);
    if (stats.isSymbolicLink()) throw new Error(`Target may not be a symlink: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
