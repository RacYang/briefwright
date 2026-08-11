import { readFile } from "node:fs/promises";
import path from "node:path";

import type { SecretReference } from "./types.js";
import { assertSafeReadPath } from "./paths.js";

export class SecretResolutionError extends Error {
  constructor(readonly reference: SecretReference, message: string) {
    super(message);
    this.name = "SecretResolutionError";
  }
}

function parseDotEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid .env.local line ${index + 1}`);
    let value = match[2] ?? "";
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(match[1]!, value);
  }
  return values;
}

async function localEnvValue(projectRoot: string, key: string): Promise<string | undefined> {
  try {
    const target = path.join(projectRoot, ".env.local");
    await assertSafeReadPath(projectRoot, target);
    const values = parseDotEnv(await readFile(target, "utf8"));
    return values.get(key);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function resolveSecret(reference: SecretReference, projectRoot: string): Promise<string> {
  let value: string | undefined;
  if (reference.provider === "env") {
    value = process.env[reference.key] ?? await localEnvValue(projectRoot, reference.key);
  } else {
    const target = path.resolve(projectRoot, reference.key);
    const relative = path.relative(projectRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new SecretResolutionError(reference, `Secret file reference must stay inside the project: ${reference.key}`);
    }
    await assertSafeReadPath(projectRoot, target);
    value = (await readFile(target, "utf8")).trim();
  }
  if (!value) {
    throw new SecretResolutionError(
      reference,
      `Missing secret ${reference.provider}:${reference.key}. Set ${reference.key} in the process environment or ignored .env.local file.`,
    );
  }
  return value;
}

export function redactSecrets(value: unknown, knownSecrets: string[] = []): unknown {
  const secretSet = new Set(knownSecrets.filter(Boolean));
  const visit = (item: unknown, key = ""): unknown => {
    if (typeof item === "string") {
      if (secretSet.has(item)) return "[REDACTED]";
      if (/api[_-]?key|authorization|token|secret/i.test(key) && !/ref|provider/i.test(key)) return "[REDACTED]";
      return item;
    }
    if (Array.isArray(item)) return item.map((entry) => visit(entry, key));
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).map(([childKey, child]) => [childKey, visit(child, childKey)]));
    }
    return item;
  };
  return visit(value);
}

export function sanitizeError(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets.filter(Boolean)) message = message.split(secret).join("[REDACTED]");
  return message.slice(0, 1000);
}
