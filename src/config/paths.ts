import path from "node:path";
import { constants, lstatSync, mkdirSync, realpathSync, type Dirent } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";

import { VaultPathUnsafeError } from "../errors.js";

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

interface StablePathIdentity {
  path: string;
  dev: string;
  ino: string;
  kind: "file" | "directory" | "symlink" | "other";
}

interface StablePathSnapshot {
  realRoot: string;
  identities: StablePathIdentity[];
  missingAt?: string;
}

export interface StablePathReadHooks {
  afterInitialValidation?: (input: { path: string; phase: string }) => void | Promise<void>;
}

function identityKind(stats: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): StablePathIdentity["kind"] {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  return "other";
}

function sameIdentity(left: StablePathIdentity, right: StablePathIdentity): boolean {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino && left.kind === right.kind;
}

function assertSameSnapshot(before: StablePathSnapshot, after: StablePathSnapshot, target: string, phase: string): void {
  if (
    before.realRoot !== after.realRoot
    || before.missingAt !== after.missingAt
    || before.identities.length !== after.identities.length
    || before.identities.some((identity, index) => !sameIdentity(identity, after.identities[index]!))
  ) {
    throw new VaultPathUnsafeError(
      "VAULT_DIRECTORY_IDENTITY_CHANGED",
      `Path identity changed during ${phase}: ${target}`,
      target,
      phase,
    );
  }
}

async function stablePathSnapshot(
  root: string,
  target: string,
  phase: string,
  options: { allowMissing: boolean; finalKind?: "file" | "directory" },
): Promise<StablePathSnapshot> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = assertContained(resolvedRoot, target);
  let realRoot: string;
  try {
    realRoot = await realpath(resolvedRoot);
  } catch (error) {
    throw new VaultPathUnsafeError("VAULT_ROOT_UNREADABLE", `Vault root cannot be resolved: ${resolvedRoot}`, resolvedRoot, phase, { cause: error });
  }
  const relative = path.relative(resolvedRoot, resolvedTarget);
  const paths = [resolvedRoot];
  let current = resolvedRoot;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    paths.push(current);
  }
  const identities: StablePathIdentity[] = [];
  for (let index = 0; index < paths.length; index += 1) {
    const pathname = paths[index]!;
    let stats;
    try {
      stats = await lstat(pathname, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.allowMissing) {
        return { realRoot, identities, missingAt: pathname };
      }
      throw new VaultPathUnsafeError("VAULT_PATH_UNREADABLE", `Vault path cannot be inspected: ${pathname}`, pathname, phase, { cause: error });
    }
    const kind = identityKind(stats);
    if (index > 0 && kind === "symlink") {
      throw new VaultPathUnsafeError("VAULT_PATH_SYMLINK", `Vault path may not traverse a symlink: ${pathname}`, pathname, phase);
    }
    const isFinal = index === paths.length - 1;
    if (!isFinal && index > 0 && kind !== "directory") {
      throw new VaultPathUnsafeError("VAULT_PATH_NOT_DIRECTORY", `Vault path component is not a directory: ${pathname}`, pathname, phase);
    }
    if (isFinal && index > 0 && options.finalKind && kind !== options.finalKind) {
      throw new VaultPathUnsafeError(
        options.finalKind === "directory" ? "VAULT_PATH_NOT_DIRECTORY" : "VAULT_PATH_NOT_FILE",
        `Vault path is not a regular ${options.finalKind}: ${pathname}`,
        pathname,
        phase,
      );
    }
    let canonical: string;
    try {
      canonical = await realpath(pathname);
    } catch (error) {
      throw new VaultPathUnsafeError("VAULT_PATH_UNREADABLE", `Vault path cannot be resolved: ${pathname}`, pathname, phase, { cause: error });
    }
    try {
      assertContained(realRoot, canonical);
    } catch (error) {
      throw new VaultPathUnsafeError(
        "VAULT_PATH_ESCAPE",
        `Vault path resolves outside the configured root: ${pathname}`,
        pathname,
        phase,
        { cause: error },
      );
    }
    identities.push({ path: pathname, dev: String(stats.dev), ino: String(stats.ino), kind });
  }
  return { realRoot, identities };
}

/**
 * Enumerate one directory only after its full ancestor identity is captured,
 * then reject the result if any persistent replacement occurred while reading.
 * This intentionally does not claim atomic protection from an adversarial ABA
 * swap because Node does not expose a cross-platform fd-relative directory walk.
 */
export async function readStableDirectory(
  root: string,
  directory: string,
  hooks: StablePathReadHooks = {},
): Promise<Dirent[]> {
  const phase = "directory-enumeration";
  const before = await stablePathSnapshot(root, directory, phase, { allowMissing: false, finalKind: "directory" });
  await hooks.afterInitialValidation?.({ path: directory, phase });
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new VaultPathUnsafeError("VAULT_DIRECTORY_READ_FAILED", `Vault directory could not be enumerated: ${directory}`, directory, phase, { cause: error });
  }
  const after = await stablePathSnapshot(root, directory, phase, { allowMissing: false, finalKind: "directory" });
  assertSameSnapshot(before, after, directory, phase);
  return entries;
}

/** Read a regular file through a verified handle, or return undefined for a stable absence. */
export async function readStableOptionalRegularFile(
  root: string,
  pathname: string,
  hooks: StablePathReadHooks = {},
): Promise<string | undefined> {
  const phase = "file-read";
  const resolvedPath = assertContained(root, pathname);
  const parent = path.dirname(resolvedPath);
  const beforeParent = await stablePathSnapshot(root, parent, phase, { allowMissing: true, finalKind: "directory" });
  if (beforeParent.missingAt) {
    await hooks.afterInitialValidation?.({ path: resolvedPath, phase });
    const afterParent = await stablePathSnapshot(root, parent, phase, { allowMissing: true, finalKind: "directory" });
    assertSameSnapshot(beforeParent, afterParent, parent, phase);
    return undefined;
  }

  let beforeFile: StablePathSnapshot;
  try {
    beforeFile = await stablePathSnapshot(root, resolvedPath, phase, { allowMissing: true, finalKind: "file" });
  } catch (error) {
    if (error instanceof VaultPathUnsafeError) throw error;
    throw new VaultPathUnsafeError("VAULT_FILE_OPEN_UNSAFE", `Vault file cannot be inspected safely: ${resolvedPath}`, resolvedPath, phase, { cause: error });
  }
  await hooks.afterInitialValidation?.({ path: resolvedPath, phase });

  let handle;
  try {
    handle = await open(resolvedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && beforeFile.missingAt) {
      const afterParent = await stablePathSnapshot(root, parent, phase, { allowMissing: false, finalKind: "directory" });
      assertSameSnapshot(beforeParent, afterParent, parent, phase);
      const afterFile = await stablePathSnapshot(root, resolvedPath, phase, { allowMissing: true, finalKind: "file" });
      assertSameSnapshot(beforeFile, afterFile, resolvedPath, phase);
      return undefined;
    }
    throw new VaultPathUnsafeError("VAULT_FILE_OPEN_UNSAFE", `Vault file cannot be opened safely: ${resolvedPath}`, resolvedPath, phase, { cause: error });
  }

  try {
    if (beforeFile.missingAt) {
      throw new VaultPathUnsafeError("VAULT_FILE_IDENTITY_CHANGED", `Vault file appeared during read: ${resolvedPath}`, resolvedPath, phase);
    }
    const handleBefore = await handle.stat({ bigint: true });
    if (!handleBefore.isFile()) {
      throw new VaultPathUnsafeError("VAULT_PATH_NOT_FILE", `Vault path is not a regular file: ${resolvedPath}`, resolvedPath, phase);
    }
    const afterOpen = await stablePathSnapshot(root, resolvedPath, phase, { allowMissing: false, finalKind: "file" });
    assertSameSnapshot(beforeFile, afterOpen, resolvedPath, phase);
    const pathIdentity = afterOpen.identities.at(-1)!;
    if (pathIdentity.dev !== String(handleBefore.dev) || pathIdentity.ino !== String(handleBefore.ino)) {
      throw new VaultPathUnsafeError("VAULT_FILE_IDENTITY_CHANGED", `Vault file handle does not match its path: ${resolvedPath}`, resolvedPath, phase);
    }
    const content = await handle.readFile("utf8");
    const handleAfter = await handle.stat({ bigint: true });
    if (
      handleBefore.dev !== handleAfter.dev
      || handleBefore.ino !== handleAfter.ino
      || handleBefore.size !== handleAfter.size
      || handleBefore.mtimeNs !== handleAfter.mtimeNs
      || handleBefore.ctimeNs !== handleAfter.ctimeNs
    ) {
      throw new VaultPathUnsafeError("VAULT_FILE_CONTENT_CHANGED", `Vault file changed while it was read: ${resolvedPath}`, resolvedPath, phase);
    }
    const afterRead = await stablePathSnapshot(root, resolvedPath, phase, { allowMissing: false, finalKind: "file" });
    assertSameSnapshot(afterOpen, afterRead, resolvedPath, phase);
    return content;
  } finally {
    await handle.close();
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
