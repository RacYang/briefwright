import { createHash } from "node:crypto";

import { canonicalJson } from "../config/load.js";
import type { BriefingItem } from "./types.js";

export const ABSENT_TARGET_HASH = "ABSENT";
export const KNOWLEDGE_OPERATIONS = ["create", "merge"] as const;
export type KnowledgeOperation = typeof KNOWLEDGE_OPERATIONS[number];
export type KnowledgeReferenceKind = "item-id" | "url" | "title";

export interface KnowledgeReference {
  kind: KnowledgeReferenceKind;
  value: string;
  runId?: string;
}

export interface KnowledgeItemIdentity {
  itemId: string;
  runId: string;
  captureId: string;
  sourceId: string;
  captureHash: string;
  canonicalUrl: string;
  title: string;
  disposition: "daily" | "review";
  generatedAt: string;
  item: BriefingItem;
}

export interface KnowledgeSelection extends KnowledgeItemIdentity {
  selectionId: string;
  selectionDigest: string;
  selectedAt: string;
}

export interface KnowledgeProposalBinding {
  proposalId: string;
  selectionId: string;
  selectionDigest: string;
  itemId: string;
  runId: string;
  captureId: string;
  captureHash: string;
  operation: KnowledgeOperation;
  targetPath: string;
  targetHeading?: string;
  expectedTargetHash: string;
  resultingContentHash: string;
  diff: string;
  expectedWriteCount: number;
  vaultScanDigest: string;
  expectedPostScanDigest: string;
}

export type KnowledgeSourceMatchKind = "EXACT_CAPTURE" | "CONFLICTING_CAPTURE" | "LEGACY_URL";

export interface KnowledgeVaultScanMatch {
  relativePath: string;
  kind: KnowledgeSourceMatchKind;
  contentHash: string;
}

export interface KnowledgeVaultScan {
  schemaVersion: "briefwright.knowledge-vault-scan/v1";
  excludedSubtrees: string[];
  matches: KnowledgeVaultScanMatch[];
}

export type KnowledgePlan =
  | {
      status: "HOLD";
      reason:
        | "CREATE_TARGET_EXISTS"
        | "MERGE_TARGET_MISSING"
        | "CREATE_WITH_HEADING"
        | "TARGET_HEADING_MISSING"
        | "DUPLICATE_SOURCE"
        | "CONFLICTING_SOURCE_VERSION";
      detail: string;
    }
  | {
      status: "PROPOSED";
      operation: KnowledgeOperation;
      expectedTargetHash: string;
      resultingContentHash: string;
      expectedWriteCount: 1;
      content: string;
      diff: string;
    };

export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function knowledgeSelectionDigest(identity: KnowledgeItemIdentity): string {
  return sha256(canonicalJson({
    schemaVersion: "briefwright.knowledge-selection/v1",
    itemId: identity.itemId,
    runId: identity.runId,
    captureId: identity.captureId,
    sourceId: identity.sourceId,
    captureHash: identity.captureHash,
    canonicalUrl: identity.canonicalUrl,
    title: identity.title,
    disposition: identity.disposition,
    generatedAt: identity.generatedAt,
  }));
}

export function knowledgeSelectionNote(selectionDigest: string): string {
  return `briefwright.knowledge-selection/v1 ${selectionDigest}`;
}

export function knowledgeTargetHash(content: string | undefined): string {
  return content === undefined ? ABSENT_TARGET_HASH : sha256(content);
}

export function knowledgeProposalDigest(binding: KnowledgeProposalBinding): string {
  return sha256(canonicalJson({
    schemaVersion: "briefwright.knowledge-proposal/v1",
    ...binding,
  }));
}

function urlDigest(url: string): string {
  return sha256(url);
}

export function knowledgeProvenanceMarker(selection: KnowledgeSelection): string {
  return `<!-- briefwright-knowledge:v1 item=${selection.itemId} capture=${selection.captureHash} url=${urlDigest(selection.canonicalUrl)} selection=${selection.selectionDigest} -->`;
}

export function renderKnowledgeFragment(selection: KnowledgeSelection): string {
  const item = selection.item;
  return [
    knowledgeProvenanceMarker(selection),
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

function insertAtHeading(existing: string, heading: string, addition: string): string | undefined {
  const lines = existing.split(/\r?\n/);
  const index = lines.findIndex((line) => line.trim() === heading.trim());
  if (index < 0) return undefined;
  const level = /^(#+)\s/.exec(lines[index]!)?.[1]?.length;
  if (!level) return undefined;
  let end = lines.length;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const match = /^(#+)\s/.exec(lines[cursor]!);
    if (match?.[1] && match[1].length <= level) {
      end = cursor;
      break;
    }
  }
  lines.splice(end, 0, "", addition.trimEnd(), "");
  return lines.join("\n");
}

function boundedDiff(before: string | undefined, after: string, maximumChangedLines = 120): string {
  const left = (before ?? "").split("\n");
  const right = after.split("\n");
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) suffix += 1;
  const removed = left.slice(prefix, left.length - suffix);
  const added = right.slice(prefix, right.length - suffix);
  const changed = [
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ];
  const visible = changed.slice(0, maximumChangedLines);
  if (changed.length > maximumChangedLines) visible.push(`... ${changed.length - maximumChangedLines} changed lines omitted`);
  return [
    `@@ before:${before === undefined ? "ABSENT" : left.length} after:${right.length} prefix:${prefix} suffix:${suffix} @@`,
    ...visible,
  ].join("\n");
}

function existingKnowledgeMarkers(content: string): Array<{ itemId: string; captureHash: string; urlHash: string }> {
  const pattern = /<!-- briefwright-knowledge:v1 item=([^\s]+) capture=([^\s]+) url=(sha256:[a-f0-9]{64}) selection=sha256:[a-f0-9]{64} -->/g;
  return [...content.matchAll(pattern)].map((match) => ({
    itemId: match[1]!,
    captureHash: match[2]!,
    urlHash: match[3]!,
  }));
}

export function knowledgeSourceMatch(
  content: string,
  selection: KnowledgeSelection,
): { kind: KnowledgeSourceMatchKind } | null {
  const sourceUrlHash = urlDigest(selection.canonicalUrl);
  const related = existingKnowledgeMarkers(content).filter((marker) =>
    marker.itemId === selection.itemId || marker.urlHash === sourceUrlHash,
  );
  if (related.some((marker) => marker.captureHash !== selection.captureHash)) {
    return { kind: "CONFLICTING_CAPTURE" };
  }
  if (related.length > 0) return { kind: "EXACT_CAPTURE" };
  if (content.includes(selection.canonicalUrl)) return { kind: "LEGACY_URL" };
  return null;
}

function normalizedVaultScan(scan: KnowledgeVaultScan): KnowledgeVaultScan {
  return {
    schemaVersion: "briefwright.knowledge-vault-scan/v1",
    excludedSubtrees: [...new Set(scan.excludedSubtrees)].sort(),
    matches: [...scan.matches].sort((left, right) =>
      `${left.relativePath}\n${left.kind}\n${left.contentHash}`.localeCompare(
        `${right.relativePath}\n${right.kind}\n${right.contentHash}`,
      ),
    ),
  };
}

export function knowledgeVaultScanDigest(scan: KnowledgeVaultScan): string {
  return sha256(canonicalJson(normalizedVaultScan(scan)));
}

export function expectedKnowledgePostScan(
  scan: KnowledgeVaultScan,
  relativeTarget: string,
  resultingContentHash: string,
): KnowledgeVaultScan {
  if (scan.matches.length !== 0) throw new Error("A knowledge proposal requires zero pre-existing source matches");
  return normalizedVaultScan({
    ...scan,
    matches: [{ relativePath: relativeTarget, kind: "EXACT_CAPTURE", contentHash: resultingContentHash }],
  });
}

export function planKnowledgeChange(input: {
  operation: KnowledgeOperation;
  targetHeading?: string;
  existing: string | undefined;
  selection: KnowledgeSelection;
}): KnowledgePlan {
  const { operation, targetHeading, existing, selection } = input;
  if (operation === "create" && existing !== undefined) {
    return { status: "HOLD", reason: "CREATE_TARGET_EXISTS", detail: "Create requires an absent target." };
  }
  if (operation === "merge" && existing === undefined) {
    return { status: "HOLD", reason: "MERGE_TARGET_MISSING", detail: "Merge requires an existing target." };
  }
  if (operation === "create" && targetHeading) {
    return { status: "HOLD", reason: "CREATE_WITH_HEADING", detail: "Create cannot target an existing heading." };
  }
  if (existing !== undefined) {
    const sourceUrlHash = urlDigest(selection.canonicalUrl);
    const related = existingKnowledgeMarkers(existing).find((marker) =>
      marker.itemId === selection.itemId || marker.urlHash === sourceUrlHash,
    );
    if (related?.captureHash === selection.captureHash) {
      return { status: "HOLD", reason: "DUPLICATE_SOURCE", detail: "The target already contains this selected source version." };
    }
    if (related) {
      return { status: "HOLD", reason: "CONFLICTING_SOURCE_VERSION", detail: "The target contains another captured version of this source." };
    }
    if (existing.includes(selection.canonicalUrl)) {
      return { status: "HOLD", reason: "DUPLICATE_SOURCE", detail: "The target already cites this canonical source without a compatible provenance marker." };
    }
  }
  const fragment = renderKnowledgeFragment(selection);
  let content: string;
  if (operation === "create") {
    content = `${fragment.trimEnd()}\n`;
  } else if (targetHeading) {
    const inserted = insertAtHeading(existing!, targetHeading, fragment);
    if (inserted === undefined) {
      return { status: "HOLD", reason: "TARGET_HEADING_MISSING", detail: `Target heading was not found: ${targetHeading}` };
    }
    content = inserted;
  } else {
    content = `${existing!.trimEnd()}\n\n${fragment.trimEnd()}\n`;
  }
  return {
    status: "PROPOSED",
    operation,
    expectedTargetHash: knowledgeTargetHash(existing),
    resultingContentHash: sha256(content),
    expectedWriteCount: 1,
    content,
    diff: boundedDiff(existing, content),
  };
}

export function renderKnowledgeProposalPreview(input: {
  proposalId: string;
  requestId?: string;
  proposalDigest: string;
  selection: KnowledgeSelection;
  operation: KnowledgeOperation;
  targetPath: string;
  targetHeading?: string;
  expectedTargetHash: string;
  resultingContentHash: string;
  expectedWriteCount: number;
  vaultScan: KnowledgeVaultScan;
  vaultScanDigest: string;
  expectedPostScanDigest: string;
  diff: string;
  content: string;
}): string {
  return [
    `# Knowledge proposal ${input.proposalId}`,
    "",
    "- Status: PROPOSED",
    `- Operation: ${input.operation}`,
    `- Target: ${input.targetPath}`,
    `- Heading: ${input.targetHeading ?? "(none)"}`,
    ...(input.requestId ? [`- Request ID: ${input.requestId}`] : []),
    `- Selection: ${input.selection.selectionId}`,
    `- Selection digest: ${input.selection.selectionDigest}`,
    `- Before: ${input.expectedTargetHash}`,
    `- After: ${input.resultingContentHash}`,
    `- Expected writes: ${input.expectedWriteCount}`,
    `- Eligible source matches before install: ${input.vaultScan.matches.length}`,
    `- Vault scan digest: ${input.vaultScanDigest}`,
    `- Expected post-install scan digest: ${input.expectedPostScanDigest}`,
    `- Proposal digest: ${input.proposalDigest}`,
    "",
    "## Bounded diff",
    "",
    "~~~diff",
    input.diff,
    "~~~",
    "",
    "## Exact resulting content",
    "",
    "~~~markdown",
    input.content.trimEnd(),
    "~~~",
    "",
  ].join("\n");
}
