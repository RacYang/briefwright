import { randomUUID } from "node:crypto";
import path from "node:path";

import { canonicalJson, loadEffectiveConfig } from "../config/load.js";
import { readStableDirectory, readStableOptionalRegularFile, resolveWithinRoot } from "../config/paths.js";
import {
  expectedKnowledgePostScan,
  knowledgeProposalDigest,
  knowledgeSelectionDigest,
  knowledgeSourceMatch,
  knowledgeVaultScanDigest,
  planKnowledgeChange,
  renderKnowledgeProposalPreview,
  sha256,
  type KnowledgeProposalBinding,
  type KnowledgeReference,
  type KnowledgeSelection,
  type KnowledgeVaultScan,
} from "../core/knowledge-intake.js";
import { writeArtifactConditionalAtomic, writeArtifactSetAtomic } from "../outputs/write.js";
import { SqliteStateStore } from "../state/sqlite.js";
import { RecoveryIncompleteError, VaultPathUnsafeError } from "../errors.js";

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalRequestId(requestId: string): string {
  if (!REQUEST_ID.test(requestId)) throw new Error("Knowledge proposal request IDs must be UUID v4 values");
  return requestId.toLowerCase();
}

const RESERVED_KNOWLEDGE_SUBTREES = [".briefwright", "briefwright.d", ".obsidian", ".trash"];

function portableRelative(value: string): string {
  return value.split(path.sep).join("/");
}

function knowledgeExclusions(documentRoot: string, briefingDirectory: string): string[] {
  const briefingPath = resolveWithinRoot(documentRoot, briefingDirectory);
  const relativeBriefing = portableRelative(path.relative(documentRoot, briefingPath));
  if (!relativeBriefing) {
    throw new Error("Knowledge intake requires a briefing directory below, not equal to, the document root");
  }
  return [...new Set([...RESERVED_KNOWLEDGE_SUBTREES, relativeBriefing])].sort();
}

function isWithinSubtree(relativePath: string, subtree: string): boolean {
  return relativePath === subtree || relativePath.startsWith(`${subtree}/`);
}

function assertKnowledgeTarget(
  documentRoot: string,
  briefingDirectory: string,
  target: string,
): { targetPath: string; relativeTarget: string; excludedSubtrees: string[] } {
  const targetPath = resolveWithinRoot(documentRoot, target);
  const relativeTarget = portableRelative(path.relative(documentRoot, targetPath));
  if (!/\.md$/i.test(targetPath)) throw new Error("Knowledge targets must be Markdown files ending in .md");
  const excludedSubtrees = knowledgeExclusions(documentRoot, briefingDirectory);
  if (relativeTarget === "briefing.yaml" || excludedSubtrees.some((subtree) => isWithinSubtree(relativeTarget, subtree))) {
    throw new Error("Knowledge targets may not modify briefing output, configuration, or internal state");
  }
  return { targetPath, relativeTarget, excludedSubtrees };
}

function isWriterArtifact(relativePath: string): boolean {
  return /\.(?:tmp|backup|displaced)-[0-9a-f-]+$/i.test(relativePath);
}

async function scanKnowledgeVault(
  documentRoot: string,
  excludedSubtrees: string[],
  selection: KnowledgeSelection,
): Promise<KnowledgeVaultScan> {
  const matches: KnowledgeVaultScan["matches"] = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = (await readStableDirectory(documentRoot, directory))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (excludedSubtrees.some((subtree) => isWithinSubtree(relativePath, subtree))) continue;
      if (entry.isSymbolicLink()) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile() || !/\.md$/i.test(entry.name) || isWriterArtifact(relativePath)) continue;
      const content = await readStableOptionalRegularFile(documentRoot, absolutePath);
      if (content === undefined) throw new Error(`Eligible Markdown disappeared during vault scan: ${relativePath}`);
      const match = knowledgeSourceMatch(content, selection);
      if (match) matches.push({ relativePath, kind: match.kind, contentHash: sha256(content) });
    }
  };
  await visit(documentRoot, "");
  return {
    schemaVersion: "briefwright.knowledge-vault-scan/v1",
    excludedSubtrees,
    matches,
  };
}

function scanHold(scan: KnowledgeVaultScan): { reason: string; detail: string } | null {
  if (scan.matches.length === 0) return null;
  const paths = scan.matches.slice(0, 5).map((match) => match.relativePath).join(", ");
  if (scan.matches.length > 1) {
    return {
      reason: "MULTIPLE_SOURCE_MATCHES",
      detail: `The selected source appears in ${scan.matches.length} eligible notes (${paths}); resolve the duplicates before proposing a write.`,
    };
  }
  if (scan.matches[0]!.kind === "CONFLICTING_CAPTURE") {
    return {
      reason: "CONFLICTING_SOURCE_VERSION",
      detail: `Another captured version of the selected source exists in ${scan.matches[0]!.relativePath}.`,
    };
  }
  return {
    reason: "DUPLICATE_SOURCE",
    detail: `The selected source already exists in ${scan.matches[0]!.relativePath}.`,
  };
}

function publicIdentity(identity: ReturnType<SqliteStateStore["resolvePublishedKnowledgeItem"]>) {
  return {
    itemId: identity.itemId,
    runId: identity.runId,
    captureId: identity.captureId,
    sourceId: identity.sourceId,
    captureHash: identity.captureHash,
    canonicalUrl: identity.canonicalUrl,
    title: identity.title,
    disposition: identity.disposition,
    generatedAt: identity.generatedAt,
  };
}

type KnowledgeProposalRecord = ReturnType<SqliteStateStore["knowledgeProposal"]>;

function requestMatchesProposal(
  proposal: KnowledgeProposalRecord,
  selectionId: string,
  targetPath: string,
  heading: string | undefined,
): boolean {
  return proposal.selectionId === selectionId
    && proposal.targetPath === targetPath
    && (proposal.targetHeading ?? undefined) === heading;
}

function renderStoredProposal(proposal: KnowledgeProposalRecord): string {
  return renderKnowledgeProposalPreview({
    proposalId: proposal.proposalId,
    ...(proposal.requestId ? { requestId: proposal.requestId } : {}),
    proposalDigest: proposal.proposalDigest,
    selection: proposal.sourceSnapshot,
    operation: proposal.operation,
    targetPath: proposal.targetPath,
    ...(proposal.targetHeading ? { targetHeading: proposal.targetHeading } : {}),
    expectedTargetHash: proposal.expectedTargetHash,
    resultingContentHash: proposal.resultingContentHash,
    expectedWriteCount: proposal.expectedWriteCount,
    vaultScan: proposal.vaultScan,
    vaultScanDigest: proposal.vaultScanDigest,
    expectedPostScanDigest: proposal.expectedPostScanDigest,
    diff: proposal.diff,
    content: proposal.content,
  });
}

async function knowledgeReadbackResult(
  config: Awaited<ReturnType<typeof loadEffectiveConfig>>,
  store: SqliteStateStore,
  proposal: KnowledgeProposalRecord,
) {
  const expectedPreview = renderStoredProposal(proposal);
  const previewPath = path.join(config.projectRoot, ".briefwright", "proposals", `${proposal.proposalId}.md`);
  const observedPreview = await readStableOptionalRegularFile(config.projectRoot, previewPath);
  const previewReadback = observedPreview === undefined
    ? { status: "MISSING" as const, expectedHash: sha256(expectedPreview), observedHash: null }
    : observedPreview === expectedPreview
      ? { status: "MATCH" as const, expectedHash: sha256(expectedPreview), observedHash: sha256(observedPreview) }
      : { status: "MISMATCH" as const, expectedHash: sha256(expectedPreview), observedHash: sha256(observedPreview) };
  const receipt = store.knowledgeCommitReceiptOrNull(proposal.proposalId);
  const observedTarget = await readStableOptionalRegularFile(config.documents.root, proposal.targetPath);
  const expectedTargetReadbackHash = receipt ? proposal.resultingContentHash : proposal.expectedTargetHash;
  const observedTargetHash = observedTarget === undefined ? "ABSENT" : sha256(observedTarget);
  const targetReadback = {
    status: observedTargetHash === expectedTargetReadbackHash ? "MATCH" as const : "MISMATCH" as const,
    expectedHash: expectedTargetReadbackHash,
    observedHash: observedTargetHash,
  };
  return {
    status: "READBACK" as const,
    requestId: proposal.requestId,
    proposalId: proposal.proposalId,
    proposalStatus: proposal.status,
    proposalDigest: proposal.proposalDigest,
    operation: proposal.operation,
    selectionId: proposal.selectionId,
    selectionDigest: proposal.selectionDigest,
    targetPath: proposal.targetPath,
    ...(proposal.targetHeading ? { targetHeading: proposal.targetHeading } : {}),
    expectedWriteCount: proposal.expectedWriteCount,
    expectedTargetHash: proposal.expectedTargetHash,
    resultingContentHash: proposal.resultingContentHash,
    vaultScanDigest: proposal.vaultScanDigest,
    expectedPostScanDigest: proposal.expectedPostScanDigest,
    diff: proposal.diff,
    previewPath,
    previewReadback,
    targetReadback,
    selectionConfirmation: {
      status: "CONSUMED" as const,
      receiptType: "knowledge-selection-receipt" as const,
      selectionId: proposal.selectionId,
      selectionDigest: proposal.selectionDigest,
    },
    commitConfirmation: receipt
      ? { status: "CONSUMED" as const, proposalDigest: proposal.proposalDigest, expectedWriteCount: proposal.expectedWriteCount }
      : { status: "REQUIRED" as const, proposalDigest: proposal.proposalDigest, expectedWriteCount: proposal.expectedWriteCount },
    commitReceipt: receipt,
    committable: proposal.status === "proposed" && previewReadback.status === "MATCH" && targetReadback.status === "MATCH",
    proposalWrites: 0,
    knowledgeTargetWrites: 0,
    writes: 0,
  };
}

function idempotencyConflict(proposal: KnowledgeProposalRecord, requestId: string, targetPath: string) {
  return {
    status: "HOLD" as const,
    reason: "IDEMPOTENCY_CONFLICT",
    detail: "The request ID is already bound to a different selection, target, or heading.",
    requestId,
    proposalId: proposal.proposalId,
    targetPath,
    proposalWrites: 0,
    knowledgeTargetWrites: 0,
  };
}

export async function resolveKnowledge(configPath: string, reference: KnowledgeReference) {
  const config = await loadEffectiveConfig(configPath);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try {
    const identity = store.resolvePublishedKnowledgeItem(reference);
    return {
      status: "RESOLVED" as const,
      ...publicIdentity(identity),
      selectionDigest: knowledgeSelectionDigest(identity),
      writes: 0,
    };
  } finally {
    store.close();
  }
}

export async function selectKnowledge(
  configPath: string,
  reference: KnowledgeReference,
  confirmation: { confirmed: boolean; expectedSelectionDigest: string },
) {
  if (confirmation.confirmed !== true) throw new Error("Knowledge selection requires explicit confirmation");
  if (!/^sha256:[a-f0-9]{64}$/.test(confirmation.expectedSelectionDigest)) {
    throw new Error("Knowledge selection requires an exact --expect-selection sha256 digest");
  }
  const config = await loadEffectiveConfig(configPath);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try {
    const selection = store.createKnowledgeSelection(reference, confirmation.expectedSelectionDigest);
    return {
      status: "SELECTED" as const,
      selectionId: selection.selectionId,
      selectionDigest: selection.selectionDigest,
      receiptType: "knowledge-selection-receipt" as const,
      created: selection.created,
      ...publicIdentity(selection),
    };
  } finally {
    store.close();
  }
}

export async function proposeKnowledge(
  configPath: string,
  selectionId: string,
  requestId: string,
  target: string,
  heading?: string,
) {
  requestId = canonicalRequestId(requestId);
  const config = await loadEffectiveConfig(configPath);
  const { targetPath, relativeTarget, excludedSubtrees } = assertKnowledgeTarget(
    config.documents.root,
    config.documents.briefingDirectory,
    target,
  );
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try {
    const existingRequest = store.knowledgeProposalByRequestId(requestId);
    if (existingRequest) {
      if (!requestMatchesProposal(existingRequest, selectionId, targetPath, heading)) {
        return idempotencyConflict(existingRequest, requestId, targetPath);
      }
      try {
        return await knowledgeReadbackResult(config, store, existingRequest);
      } catch (error) {
        if (error instanceof VaultPathUnsafeError) {
          return {
            status: "HOLD" as const,
            reason: "VAULT_PATH_UNSAFE",
            detail: error.message,
            errorCode: error.code,
            path: error.path,
            phase: error.phase,
            requestId,
            selectionId,
            targetPath,
            proposalWrites: 0,
            knowledgeTargetWrites: 0,
          };
        }
        throw error;
      }
    }

    const selection = store.knowledgeSelection(selectionId);
    let existing: string | undefined;
    try {
      existing = await readStableOptionalRegularFile(config.documents.root, targetPath);
    } catch (error) {
      if (error instanceof VaultPathUnsafeError) {
        return {
          status: "HOLD" as const,
          reason: "VAULT_PATH_UNSAFE",
          detail: error.message,
          errorCode: error.code,
          path: error.path,
          phase: error.phase,
          requestId,
          selectionId,
          targetPath,
          proposalWrites: 0,
          knowledgeTargetWrites: 0,
        };
      }
      throw error;
    }
    let vaultScan: KnowledgeVaultScan;
    try {
      vaultScan = await scanKnowledgeVault(config.documents.root, excludedSubtrees, selection);
    } catch (error) {
      if (error instanceof VaultPathUnsafeError) {
        return {
          status: "HOLD" as const,
          reason: "VAULT_PATH_UNSAFE",
          detail: error.message,
          errorCode: error.code,
          path: error.path,
          phase: error.phase,
          requestId,
          selectionId,
          targetPath,
          targetExists: existing !== undefined,
          proposalWrites: 0,
          knowledgeTargetWrites: 0,
        };
      }
      return {
        status: "HOLD" as const,
        reason: "VAULT_SCAN_INCOMPLETE",
        detail: error instanceof Error ? error.message : String(error),
        requestId,
        selectionId,
        targetPath,
        targetExists: existing !== undefined,
        proposalWrites: 0,
        knowledgeTargetWrites: 0,
      };
    }
    const blocked = scanHold(vaultScan);
    if (blocked) {
      return {
        status: "HOLD" as const,
        ...blocked,
        requestId,
        selectionId,
        targetPath,
        targetExists: existing !== undefined,
        vaultScanDigest: knowledgeVaultScanDigest(vaultScan),
        sourceMatches: vaultScan.matches,
        proposalWrites: 0,
        knowledgeTargetWrites: 0,
      };
    }
    const operation = existing === undefined ? "create" as const : "merge" as const;
    const plan = planKnowledgeChange({
      operation,
      ...(heading ? { targetHeading: heading } : {}),
      existing,
      selection,
    });
    if (plan.status === "HOLD") {
      return {
        status: "HOLD" as const,
        reason: plan.reason,
        detail: plan.detail,
        requestId,
        selectionId,
        targetPath,
        targetExists: existing !== undefined,
        proposalWrites: 0,
        knowledgeTargetWrites: 0,
      };
    }
    const vaultScanDigest = knowledgeVaultScanDigest(vaultScan);
    const expectedPostScanDigest = knowledgeVaultScanDigest(
      expectedKnowledgePostScan(vaultScan, relativeTarget, plan.resultingContentHash),
    );
    const proposalId = `KNP-${randomUUID()}`;
    const binding: KnowledgeProposalBinding = {
      proposalId,
      selectionId,
      selectionDigest: selection.selectionDigest,
      itemId: selection.itemId,
      runId: selection.runId,
      captureId: selection.captureId,
      captureHash: selection.captureHash,
      operation,
      targetPath,
      ...(heading ? { targetHeading: heading } : {}),
      expectedTargetHash: plan.expectedTargetHash,
      resultingContentHash: plan.resultingContentHash,
      diff: plan.diff,
      expectedWriteCount: plan.expectedWriteCount,
      vaultScanDigest,
      expectedPostScanDigest,
    };
    const proposalDigest = knowledgeProposalDigest(binding);
    const previewPath = path.join(config.projectRoot, ".briefwright", "proposals", `${proposalId}.md`);
    const preview = renderKnowledgeProposalPreview({
      proposalId,
      requestId,
      proposalDigest,
      selection,
      operation,
      targetPath,
      ...(heading ? { targetHeading: heading } : {}),
      expectedTargetHash: plan.expectedTargetHash,
      resultingContentHash: plan.resultingContentHash,
      expectedWriteCount: plan.expectedWriteCount,
      vaultScan,
      vaultScanDigest,
      expectedPostScanDigest,
      diff: plan.diff,
      content: plan.content,
    });
    try {
      await writeArtifactSetAtomic(config.projectRoot, [{ path: previewPath, content: preview }], () => {
        store.createKnowledgeProposal({
          ...binding,
          requestId,
          proposalDigest,
          content: plan.content,
          sourceSnapshot: selection,
          vaultScan,
        });
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: knowledge_proposals.request_id")) {
        const winner = store.knowledgeProposalByRequestId(requestId);
        if (winner && requestMatchesProposal(winner, selectionId, targetPath, heading)) {
          return await knowledgeReadbackResult(config, store, winner);
        }
        if (winner) return idempotencyConflict(winner, requestId, targetPath);
      }
      throw error;
    }
    return {
      status: "PROPOSED" as const,
      requestId,
      proposalId,
      proposalDigest,
      selectionId,
      operation,
      targetPath,
      ...(heading ? { targetHeading: heading } : {}),
      previewPath,
      targetExists: existing !== undefined,
      expectedTargetHash: plan.expectedTargetHash,
      resultingContentHash: plan.resultingContentHash,
      expectedWriteCount: plan.expectedWriteCount,
      vaultScanDigest,
      expectedPostScanDigest,
      diff: plan.diff,
      proposalWrites: 1,
      knowledgeTargetWrites: 0,
    };
  } finally {
    store.close();
  }
}

export async function readbackKnowledge(
  configPath: string,
  reference: { requestId?: string; proposalId?: string },
) {
  const count = Number(Boolean(reference.requestId)) + Number(Boolean(reference.proposalId));
  if (count !== 1) throw new Error("Specify exactly one of --request-id or --proposal-id");
  const requestId = reference.requestId ? canonicalRequestId(reference.requestId) : undefined;
  const config = await loadEffectiveConfig(configPath);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot, { readOnly: true });
  try {
    const proposal = requestId
      ? store.knowledgeProposalByRequestId(requestId)
      : store.knowledgeProposal(reference.proposalId!);
    if (!proposal) throw new Error(`Knowledge proposal request not found: ${requestId}`);
    try {
      return await knowledgeReadbackResult(config, store, proposal);
    } catch (error) {
      if (error instanceof VaultPathUnsafeError) {
        throw error.attachContext({ command: "knowledge readback", proposalId: proposal.proposalId });
      }
      throw error;
    }
  } finally {
    store.close();
  }
}

export async function commitKnowledge(
  configPath: string,
  proposalId: string,
  confirmation: { confirmed: boolean; proposalDigest: string; expectedWrites: number },
) {
  if (confirmation.confirmed !== true) throw new Error("Knowledge commit requires explicit confirmation");
  if (!/^sha256:[a-f0-9]{64}$/.test(confirmation.proposalDigest)) {
    throw new Error("Knowledge commit requires an exact --expect-digest sha256 value");
  }
  if (confirmation.expectedWrites !== 1) {
    throw new Error("Knowledge commit requires --expect-writes 1");
  }
  const config = await loadEffectiveConfig(configPath);
  const store = new SqliteStateStore(config.storage.path, config.projectRoot);
  try {
    const proposal = store.knowledgeProposal(proposalId);
    if (proposal.status !== "proposed") throw new Error(`Knowledge proposal ${proposalId} is ${proposal.status}`);
    if (proposal.proposalDigest !== confirmation.proposalDigest) {
      throw new Error("Knowledge proposal digest does not match the reviewed proposal");
    }
    if (proposal.expectedWriteCount !== confirmation.expectedWrites) {
      throw new Error("Knowledge proposal write count does not match the reviewed proposal");
    }
    if (canonicalJson(proposal.sourceSnapshot) !== canonicalJson(store.knowledgeSelection(proposal.selectionId))) {
      throw new Error("Knowledge proposal selection changed before commit");
    }
    const proposalReadback = await knowledgeReadbackResult(config, store, proposal);
    if (proposalReadback.previewReadback.status !== "MATCH") {
      throw new Error(`Knowledge proposal preview readback is ${proposalReadback.previewReadback.status}; propose again before committing`);
    }
    const { excludedSubtrees } = assertKnowledgeTarget(
      config.documents.root,
      config.documents.briefingDirectory,
      portableRelative(path.relative(config.documents.root, proposal.targetPath)),
    );
    if (sha256(proposal.content) !== proposal.resultingContentHash) {
      throw new Error("Knowledge proposal content changed after preview");
    }
    const committed = await writeArtifactConditionalAtomic(
      config.documents.root,
      { path: proposal.targetPath, content: proposal.content, expectedHash: proposal.expectedTargetHash },
      async () => {
        const observed = await readStableOptionalRegularFile(config.documents.root, proposal.targetPath);
        if (observed !== proposal.content) {
          throw new Error("Knowledge target byte readback did not match the reviewed proposal");
        }
        const postInstallScan = await scanKnowledgeVault(config.documents.root, excludedSubtrees, proposal.sourceSnapshot);
        if (knowledgeVaultScanDigest(postInstallScan) !== proposal.expectedPostScanDigest) {
          throw new Error("Knowledge vault source matches changed during install; target rollback is required");
        }
        const observedResultHash = sha256(observed);
        return store.commitKnowledgeWithReceipt({
          proposalId,
          proposalDigest: proposal.proposalDigest,
          expectedWriteCount: proposal.expectedWriteCount,
          targetPath: proposal.targetPath,
          expectedTargetHash: proposal.expectedTargetHash,
          expectedResultHash: proposal.resultingContentHash,
          observedResultHash,
          observedBytes: Buffer.byteLength(observed, "utf8"),
        });
      },
      async () => {
        const preInstallScan = await scanKnowledgeVault(config.documents.root, excludedSubtrees, proposal.sourceSnapshot);
        if (knowledgeVaultScanDigest(preInstallScan) !== proposal.vaultScanDigest) {
          throw new Error("Knowledge vault source matches changed after preview; create a fresh proposal before committing");
        }
      },
    );
    const receipt = committed.result;
    return {
      status: "COMMITTED" as const,
      requestId: proposal.requestId,
      proposalId,
      proposalDigest: proposal.proposalDigest,
      expectedWriteCount: proposal.expectedWriteCount,
      targetPath: proposal.targetPath,
      contentHash: receipt.observedResultHash,
      observedBytes: receipt.observedBytes,
      receiptId: receipt.receiptId,
      readbackStatus: receipt.readbackStatus,
      committedAt: receipt.committedAt,
      cleanupWarnings: committed.cleanupWarnings,
    };
  } catch (error) {
    if (error instanceof RecoveryIncompleteError || error instanceof VaultPathUnsafeError) {
      const receiptStatus = store.knowledgeCommitReceiptOrNull(proposalId)?.readbackStatus === "MATCH" ? "MATCH" as const : "ABSENT" as const;
      throw error.attachContext({ command: "knowledge commit", proposalId, receiptStatus });
    }
    throw error;
  } finally {
    store.close();
  }
}
