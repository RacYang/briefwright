import path from "node:path";

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

