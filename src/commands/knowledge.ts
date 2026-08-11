import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { loadEffectiveConfig } from "../config/load.js";
import { resolveWithinRoot, prepareSafeFilePath } from "../config/paths.js";
import { writeArtifactAtomic, writeArtifactSetAtomic } from "../outputs/write.js";
import { SqliteStateStore } from "../state/sqlite.js";

async function optionalFile(pathname: string): Promise<string | undefined> {
  try { return await readFile(pathname, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function proposalContent(item: ReturnType<SqliteStateStore["itemForKnowledge"]>): string {
  return [
    `## ${item.title}`,
    "",
    "### Problem and preconditions",
    "",
    item.whyItMatters,
    "",
    "### Mechanism or process",
    "",
    item.summary,
    "",
    "### Choices and boundaries",
    "",
    `Evidence status: ${item.evidenceStatus ?? item.evidence}. This proposal is bounded to the cited source and does not generalize unsupported claims.`,
    "",
    "### Failure paths",
    "",
    "Re-check the canonical source if its content, availability, or version changes. Do not treat inaccessible or secondary evidence as confirmation.",
    "",
    "### Validation and next step",
    "",
    `Review the claim against <${item.url}> and validate it in the target system before relying on it.`,
    "",
    "### Evidence",
    "",
    `- Source: <${item.url}>`,
    ...((item.claims ?? []).map((claim) => `- ${claim}`)),
    "",
  ].join("\n");
}

export async function proposeKnowledge(configPath: string, itemId: string, target: string, heading?: string) {
  const config = await loadEffectiveConfig(configPath);
  const targetPath = resolveWithinRoot(config.projectRoot, target);
  await prepareSafeFilePath(config.projectRoot, targetPath);
  const existing = await optionalFile(targetPath);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try {
    const content = proposalContent(store.itemForKnowledge(itemId));
    const proposalId = store.createKnowledgeProposal(itemId, targetPath, heading, existing === undefined ? undefined : hash(existing), content);
    const previewPath = path.join(config.projectRoot, ".briefwright", "proposals", `${proposalId}.md`);
    await writeArtifactAtomic(config.projectRoot, previewPath, content);
    return { proposalId, targetPath, previewPath, targetExists: existing !== undefined, expectedTargetHash: existing === undefined ? null : hash(existing) };
  } finally { store.close(); }
}

function insertAtHeading(existing: string, heading: string, addition: string): string {
  const lines = existing.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() === heading.trim());
  if (index < 0) throw new Error(`Target heading was not found: ${heading}`);
  const level = /^(#+)\s/.exec(lines[index]!)?.[1]?.length;
  if (!level) throw new Error(`Target heading is not a Markdown heading: ${heading}`);
  let end = lines.length;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const match = /^(#+)\s/.exec(lines[cursor]!);
    if (match?.[1] && match[1].length <= level) { end = cursor; break; }
  }
  lines.splice(end, 0, "", addition.trimEnd(), "");
  return lines.join("\n");
}

export async function commitKnowledge(configPath: string, proposalId: string) {
  const config = await loadEffectiveConfig(configPath);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try {
    const proposal = store.knowledgeProposal(proposalId);
    if (proposal.status !== "proposed") throw new Error(`Knowledge proposal ${proposalId} is ${proposal.status}`);
    await prepareSafeFilePath(config.projectRoot, proposal.targetPath);
    const existing = await optionalFile(proposal.targetPath);
    const currentHash = existing === undefined ? undefined : hash(existing);
    if (currentHash !== proposal.expectedTargetHash) throw new Error("Knowledge target changed after preview; create a fresh proposal before committing");
    const next = existing === undefined
      ? `${proposal.content.trimEnd()}\n`
      : proposal.targetHeading
        ? insertAtHeading(existing, proposal.targetHeading, proposal.content)
        : `${existing.trimEnd()}\n\n${proposal.content.trimEnd()}\n`;
    await writeArtifactSetAtomic(config.projectRoot, [{ path: proposal.targetPath, content: next }], () => store.markKnowledgeCommitted(proposalId));
    await access(proposal.targetPath);
    return { proposalId, targetPath: proposal.targetPath, contentHash: hash(next) };
  } finally { store.close(); }
}
