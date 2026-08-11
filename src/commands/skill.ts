import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = ".briefwright-managed.json";
const FILES = ["SKILL.md", "agents/openai.yaml"] as const;

interface ManagedSkillReceipt {
  manager: "briefwright";
  version: string;
  files: Record<string, string>;
}

function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function packagedSkillRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../skill/briefwright");
}

export function defaultSkillDestination(): string {
  return path.join(homedir(), ".codex", "skills", "briefwright");
}

function readReceipt(destination: string): ManagedSkillReceipt | undefined {
  const receiptPath = path.join(destination, MANIFEST);
  if (!existsSync(receiptPath)) return undefined;
  const parsed = JSON.parse(readFileSync(receiptPath, "utf8")) as Partial<ManagedSkillReceipt>;
  if (parsed.manager !== "briefwright" || typeof parsed.version !== "string" || !parsed.files) return undefined;
  const entries = Object.entries(parsed.files);
  if (entries.length !== FILES.length || entries.some(([relative, hash]) => !FILES.includes(relative as typeof FILES[number]) || !/^[a-f0-9]{64}$/.test(hash))) return undefined;
  return parsed as ManagedSkillReceipt;
}

function assertSafeDestination(destination: string): void {
  const resolved = path.resolve(destination);
  const root = path.parse(resolved).root;
  let current = root;
  for (const segment of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Skill destination may not use symlinks: ${current}`);
  }
}

async function atomicWrite(filePath: string, contents: Buffer | string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (existsSync(filePath) && lstatSync(filePath).isSymbolicLink()) throw new Error(`Skill file may not be a symlink: ${filePath}`);
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o644 });
    await rename(temporary, filePath);
  } finally {
    try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export async function skillStatus(destination = defaultSkillDestination()): Promise<{
  destination: string;
  installed: boolean;
  managed: boolean;
  version?: string;
  intact?: boolean;
}> {
  const resolved = path.resolve(destination);
  assertSafeDestination(resolved);
  if (!existsSync(resolved)) return { destination: resolved, installed: false, managed: false };
  const receipt = readReceipt(resolved);
  if (!receipt) return { destination: resolved, installed: true, managed: false };
  const intact = Object.entries(receipt.files).every(([relative, expected]) => {
    const target = path.join(resolved, relative);
    return existsSync(target) && !lstatSync(target).isSymbolicLink() && digest(readFileSync(target)) === expected;
  });
  return { destination: resolved, installed: true, managed: true, version: receipt.version, intact };
}

export async function installSkill(options: { destination?: string; yes: boolean; version: string }): Promise<{
  destination: string;
  installed: true;
  updated: boolean;
  version: string;
}> {
  if (!options.yes) throw new Error("Skill installation writes to the Codex skills directory; confirm with --yes");
  const source = packagedSkillRoot();
  const destination = path.resolve(options.destination ?? defaultSkillDestination());
  assertSafeDestination(destination);
  const previous = await skillStatus(destination);
  if (previous.installed && !previous.managed) {
    throw new Error(`Refusing to overwrite an unmanaged skill at ${destination}`);
  }
  if (previous.managed && previous.intact === false) {
    throw new Error(`Refusing to overwrite locally modified managed skill files at ${destination}`);
  }

  const payloads = new Map<string, Buffer>();
  for (const relative of FILES) {
    const sourcePath = path.join(source, relative);
    if (!existsSync(sourcePath)) throw new Error(`Packaged Skill is missing ${relative}`);
    payloads.set(relative, await readFile(sourcePath));
  }
  const receipt: ManagedSkillReceipt = {
    manager: "briefwright",
    version: options.version,
    files: Object.fromEntries([...payloads].map(([relative, contents]) => [relative, digest(contents)])),
  };
  for (const [relative, contents] of payloads) await atomicWrite(path.join(destination, relative), contents);
  await atomicWrite(path.join(destination, MANIFEST), `${JSON.stringify(receipt, null, 2)}\n`);
  return { destination, installed: true, updated: previous.installed, version: options.version };
}
