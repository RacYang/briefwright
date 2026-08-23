import { randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { addProjectFeedback, projectFeedbackSummary } from "../src/commands/feedback.js";
import { commitKnowledge, proposeKnowledge, readbackKnowledge, resolveKnowledge, selectKnowledge } from "../src/commands/knowledge.js";
import { initializeProject } from "../src/commands/init.js";
import { runFormalProject } from "../src/core/run.js";
import { ABSENT_TARGET_HASH, sha256 } from "../src/core/knowledge-intake.js";
import { writeArtifactConditionalAtomic, writeArtifactSetAtomic } from "../src/outputs/write.js";
import { FixtureModelProvider } from "../src/providers/fixture.js";
import { RecoveryIncompleteError, serializeCommandError } from "../src/errors.js";

function response(url: string): Response {
  if (url.includes("github")) {
    return new Response(JSON.stringify([{
      id: 1,
      html_url: "https://github.com/QwenLM/qwen-code/releases/tag/v1",
      name: "AI agents runtime",
      tag_name: "v1",
      body: "AI agents runtime adds tool budgets",
      published_at: "2026-08-11T00:00:00Z",
      draft: false,
      prerelease: false,
    }]), { status: 200 });
  }
  return new Response("<rss><channel></channel></rss>", { status: 200 });
}

function scalar(databasePath: string, sql: string): number {
  const database = new DatabaseSync(databasePath);
  try {
    return Number((database.prepare(sql).get() as { count: number }).count);
  } finally {
    database.close();
  }
}

function textScalar(databasePath: string, sql: string): string {
  const database = new DatabaseSync(databasePath);
  try {
    return String((database.prepare(sql).get() as { value: string }).value);
  } finally {
    database.close();
  }
}

function selectionMarker(selection: {
  itemId: string;
  captureHash: string;
  canonicalUrl: string;
  selectionDigest: string;
}): string {
  return `<!-- briefwright-knowledge:v1 item=${selection.itemId} capture=${selection.captureHash} url=${sha256(selection.canonicalUrl)} selection=${selection.selectionDigest} -->`;
}

describe("governed knowledge intake", () => {
  it("binds selection, proposal, confirmation, target write, and readback while failing closed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-knowledge-intake-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    const run = await runFormalProject(configPath, {
      now: new Date("2026-08-11T02:00:00Z"),
      provider: new FixtureModelProvider(),
      fetch: async (url) => response(String(url)),
    });
    const item = run.result.daily[0]!;
    const reference = { kind: "item-id" as const, value: item.id, runId: run.runId };
    const databasePath = path.join(root, ".briefwright", "state.db");

    const resolved = await resolveKnowledge(configPath, reference);
    expect(resolved).toMatchObject({
      status: "RESOLVED",
      itemId: item.id,
      runId: run.runId,
      captureHash: item.captureHash,
      writes: 0,
    });
    expect(resolved.selectionDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    await expect(selectKnowledge(configPath, reference, {
      confirmed: true,
      expectedSelectionDigest: `sha256:${"0".repeat(64)}`,
    })).rejects.toThrow("identity changed after resolve");
    expect(scalar(databasePath, "SELECT COUNT(*) count FROM feedback")).toBe(0);
    expect(scalar(databasePath, "SELECT COUNT(*) count FROM knowledge_selections")).toBe(0);

    const selected = await selectKnowledge(configPath, reference, {
      confirmed: true,
      expectedSelectionDigest: resolved.selectionDigest,
    });
    expect(selected).toMatchObject({
      status: "SELECTED",
      itemId: item.id,
      runId: run.runId,
      created: true,
    });
    expect(scalar(databasePath, "SELECT COUNT(*) count FROM knowledge_selections")).toBe(1);

    const genericFeedback = await addProjectFeedback(
      configPath,
      item.id,
      "knowledge-worthy",
      "A generic feedback record is not a knowledge selection receipt",
    );
    await expect(projectFeedbackSummary(configPath)).resolves.toMatchObject({
      total: 1,
      reviewedItems: 1,
      selectionReceipts: 1,
      effectivePositiveItems: 1,
      byType: { "knowledge-worthy": 1 },
    });
    expect(textScalar(databasePath, `SELECT feedback_type value FROM feedback WHERE feedback_id=(SELECT feedback_id FROM knowledge_selections WHERE selection_id='${selected.selectionId}')`))
      .toBe("knowledge-selection-receipt");
    await expect(proposeKnowledge(
      configPath,
      genericFeedback.feedbackId,
      randomUUID(),
      "knowledge/not-selected.md",
    )).rejects.toThrow("Knowledge selection not found");
    expect(scalar(databasePath, "SELECT COUNT(*) count FROM knowledge_proposals")).toBe(0);

    await expect(proposeKnowledge(configPath, selected.selectionId, randomUUID(), "briefing.yaml")).rejects.toThrow("Markdown files");
    await expect(proposeKnowledge(configPath, selected.selectionId, randomUUID(), ".briefwright/notes.md")).rejects.toThrow("internal state");

    const targetDirectory = path.join(root, "knowledge");
    const marker = selectionMarker(selected);
    const existingElsewhere = path.join(root, "existing.md");
    await writeFile(existingElsewhere, `${marker}\n`, "utf8");
    const crossFileDuplicate = await proposeKnowledge(
      configPath,
      selected.selectionId,
      randomUUID(),
      "knowledge/agents.md",
    );
    expect(crossFileDuplicate).toMatchObject({
      status: "HOLD",
      reason: "DUPLICATE_SOURCE",
      proposalWrites: 0,
      knowledgeTargetWrites: 0,
    });
    expect(scalar(databasePath, "SELECT COUNT(*) count FROM knowledge_proposals")).toBe(0);
    await expect(access(targetDirectory)).rejects.toThrow();
    await rm(existingElsewhere);

    await writeFile(path.join(root, ".briefwright", "excluded-source.md"), `${marker}\n`, "utf8");
    const conflictPath = path.join(root, "conflict.md");
    await writeFile(conflictPath, `${marker.replace(`capture=${selected.captureHash}`, "capture=DIFFERENT")}\n`, "utf8");
    const conflict = await proposeKnowledge(
      configPath,
      selected.selectionId,
      randomUUID(),
      "knowledge/agents.md",
    );
    expect(conflict).toMatchObject({ status: "HOLD", reason: "CONFLICTING_SOURCE_VERSION", proposalWrites: 0, knowledgeTargetWrites: 0 });
    expect(scalar(databasePath, "SELECT COUNT(*) count FROM knowledge_proposals")).toBe(0);
    await rm(conflictPath);

    const proposalRequestId = randomUUID();
    const proposal = await proposeKnowledge(
      configPath,
      selected.selectionId,
      proposalRequestId,
      "knowledge/agents.md",
    );
    if (proposal.status !== "PROPOSED") throw new Error(`Unexpected proposal status: ${proposal.status}`);
    expect(proposal.operation).toBe("create");
    await expect(access(targetDirectory)).rejects.toThrow();
    await expect(access(proposal.targetPath)).rejects.toThrow();
    const preview = await readFile(proposal.previewPath, "utf8");
    expect(preview).toContain(proposal.proposalDigest);
    expect(preview).toContain("## Bounded diff");
    expect(preview).toContain("Expected writes: 1");
    expect(preview).toContain("Eligible source matches before install: 0");
    expect(preview).toContain(proposal.vaultScanDigest);
    expect(preview).toContain(`Request ID: ${proposalRequestId}`);

    const proposalCountAfterFirstRequest = scalar(databasePath, "SELECT COUNT(*) count FROM knowledge_proposals");
    const proposalFilesAfterFirstRequest = await readdir(path.dirname(proposal.previewPath));
    const replayedRequest = await proposeKnowledge(
      configPath,
      selected.selectionId,
      proposalRequestId.toUpperCase(),
      "knowledge/agents.md",
    );
    expect(replayedRequest).toMatchObject({
      status: "READBACK",
      requestId: proposalRequestId,
      proposalId: proposal.proposalId,
      proposalDigest: proposal.proposalDigest,
      operation: proposal.operation,
      expectedTargetHash: proposal.expectedTargetHash,
      resultingContentHash: proposal.resultingContentHash,
      vaultScanDigest: proposal.vaultScanDigest,
      expectedPostScanDigest: proposal.expectedPostScanDigest,
      diff: proposal.diff,
      previewReadback: { status: "MATCH" },
      targetReadback: { status: "MATCH" },
      selectionConfirmation: { status: "CONSUMED", receiptType: "knowledge-selection-receipt" },
      commitConfirmation: { status: "REQUIRED" },
      proposalWrites: 0,
      knowledgeTargetWrites: 0,
      writes: 0,
    });
    expect(scalar(databasePath, "SELECT COUNT(*) count FROM knowledge_proposals")).toBe(proposalCountAfterFirstRequest);
    expect(await readdir(path.dirname(proposal.previewPath))).toEqual(proposalFilesAfterFirstRequest);
    expect(await readFile(proposal.previewPath, "utf8")).toBe(preview);
    await expect(proposeKnowledge(
      configPath,
      selected.selectionId,
      proposalRequestId,
      "knowledge/different.md",
    )).resolves.toMatchObject({ status: "HOLD", reason: "IDEMPOTENCY_CONFLICT", proposalWrites: 0, knowledgeTargetWrites: 0 });
    expect(scalar(databasePath, "SELECT COUNT(*) count FROM knowledge_proposals")).toBe(proposalCountAfterFirstRequest);

    const stale = await proposeKnowledge(
      configPath,
      selected.selectionId,
      randomUUID(),
      "knowledge/stale.md",
    );
    if (stale.status !== "PROPOSED") throw new Error(`Unexpected stale proposal status: ${stale.status}`);
    const rollback = await proposeKnowledge(
      configPath,
      selected.selectionId,
      randomUUID(),
      "knowledge/rollback.md",
    );
    if (rollback.status !== "PROPOSED") throw new Error(`Unexpected rollback proposal status: ${rollback.status}`);

    await expect(commitKnowledge(configPath, proposal.proposalId, {
      confirmed: false,
      proposalDigest: proposal.proposalDigest,
      expectedWrites: 1,
    })).rejects.toThrow("explicit confirmation");
    await expect(access(targetDirectory)).rejects.toThrow();

    await expect(commitKnowledge(configPath, proposal.proposalId, {
      confirmed: true,
      proposalDigest: `sha256:${"0".repeat(64)}`,
      expectedWrites: 1,
    })).rejects.toThrow("does not match");
    await expect(access(targetDirectory)).rejects.toThrow();

    await mkdir(targetDirectory, { recursive: true });
    const mergeTarget = path.join(targetDirectory, "topic.md");
    await writeFile(mergeTarget, "# Existing topic\n", "utf8");
    const mergeProposal = await proposeKnowledge(configPath, selected.selectionId, randomUUID(), "knowledge/topic.md");
    if (mergeProposal.status !== "PROPOSED") throw new Error(`Unexpected merge proposal status: ${mergeProposal.status}`);
    expect(mergeProposal.operation).toBe("merge");
    expect(await readFile(mergeTarget, "utf8")).toBe("# Existing topic\n");

    await writeFile(stale.targetPath, "human edit\n", "utf8");
    await expect(commitKnowledge(configPath, stale.proposalId, {
      confirmed: true,
      proposalDigest: stale.proposalDigest,
      expectedWrites: 1,
    })).rejects.toThrow("refusing to clobber");
    expect(await readFile(stale.targetPath, "utf8")).toBe("human edit\n");
    expect(textScalar(databasePath, `SELECT status value FROM knowledge_proposals WHERE proposal_id='${stale.proposalId}'`)).toBe("proposed");
    expect(scalar(databasePath, "SELECT COUNT(*) count FROM knowledge_commit_receipts")).toBe(0);

    const failingDatabase = new DatabaseSync(databasePath);
    failingDatabase.exec(`CREATE TRIGGER fail_knowledge_receipt BEFORE INSERT ON knowledge_commit_receipts
      BEGIN SELECT RAISE(ABORT, 'forced receipt failure'); END;`);
    failingDatabase.close();
    await expect(commitKnowledge(configPath, rollback.proposalId, {
      confirmed: true,
      proposalDigest: rollback.proposalDigest,
      expectedWrites: 1,
    })).rejects.toThrow("forced receipt failure");
    await expect(access(rollback.targetPath)).rejects.toThrow();
    expect(textScalar(databasePath, `SELECT status value FROM knowledge_proposals WHERE proposal_id='${rollback.proposalId}'`)).toBe("proposed");
    expect(scalar(databasePath, "SELECT COUNT(*) count FROM knowledge_commit_receipts")).toBe(0);
    const repairedDatabase = new DatabaseSync(databasePath);
    repairedDatabase.exec("DROP TRIGGER fail_knowledge_receipt");
    repairedDatabase.close();

    const lateDuplicate = path.join(root, "late-duplicate.md");
    await writeFile(lateDuplicate, `${marker}\n`, "utf8");
    await expect(commitKnowledge(configPath, proposal.proposalId, {
      confirmed: true,
      proposalDigest: proposal.proposalDigest,
      expectedWrites: 1,
    })).rejects.toThrow("vault source matches changed after preview");
    await expect(access(proposal.targetPath)).rejects.toThrow();
    expect(textScalar(databasePath, `SELECT status value FROM knowledge_proposals WHERE proposal_id='${proposal.proposalId}'`)).toBe("proposed");
    expect(scalar(databasePath, "SELECT COUNT(*) count FROM knowledge_commit_receipts")).toBe(0);
    await rm(lateDuplicate);

    const committed = await commitKnowledge(configPath, proposal.proposalId, {
      confirmed: true,
      proposalDigest: proposal.proposalDigest,
      expectedWrites: 1,
    });
    const written = await readFile(committed.targetPath, "utf8");
    expect(committed).toMatchObject({
      status: "COMMITTED",
      proposalId: proposal.proposalId,
      proposalDigest: proposal.proposalDigest,
      expectedWriteCount: 1,
      readbackStatus: "MATCH",
      cleanupWarnings: [],
    });
    expect(committed.contentHash).toBe(proposal.resultingContentHash);
    expect(Buffer.byteLength(written, "utf8")).toBe(committed.observedBytes);
    expect(written).toContain(`item=${item.id}`);
    expect(scalar(databasePath, "SELECT COUNT(*) count FROM knowledge_commit_receipts WHERE readback_status='MATCH'")).toBe(1);
    const receiptCountBeforeReadback = scalar(databasePath, "SELECT COUNT(*) count FROM knowledge_commit_receipts");
    const proposalCountBeforeReadback = scalar(databasePath, "SELECT COUNT(*) count FROM knowledge_proposals");
    const previewBeforeReadback = await readFile(proposal.previewPath, "utf8");
    const committedReadback = await readbackKnowledge(configPath, { requestId: proposalRequestId.toUpperCase() });
    expect(committedReadback).toMatchObject({
      status: "READBACK",
      proposalId: proposal.proposalId,
      proposalStatus: "committed",
      selectionConfirmation: { status: "CONSUMED" },
      commitConfirmation: { status: "CONSUMED" },
      commitReceipt: { receiptId: committed.receiptId, readbackStatus: "MATCH" },
      previewReadback: { status: "MATCH" },
      targetReadback: { status: "MATCH" },
      committable: false,
      writes: 0,
    });
    await expect(readbackKnowledge(configPath, { proposalId: proposal.proposalId })).resolves.toMatchObject({
      proposalId: proposal.proposalId,
      writes: 0,
    });
    expect(scalar(databasePath, "SELECT COUNT(*) count FROM knowledge_commit_receipts")).toBe(receiptCountBeforeReadback);
    expect(scalar(databasePath, "SELECT COUNT(*) count FROM knowledge_proposals")).toBe(proposalCountBeforeReadback);
    expect(await readFile(proposal.previewPath, "utf8")).toBe(previewBeforeReadback);
    expect(await readFile(committed.targetPath, "utf8")).toBe(written);

    const proposalCount = scalar(databasePath, "SELECT COUNT(*) count FROM knowledge_proposals");
    const duplicate = await proposeKnowledge(
      configPath,
      selected.selectionId,
      randomUUID(),
      "knowledge/another-copy.md",
    );
    expect(duplicate).toMatchObject({ status: "HOLD", reason: "DUPLICATE_SOURCE", proposalWrites: 0, knowledgeTargetWrites: 0 });
    expect(scalar(databasePath, "SELECT COUNT(*) count FROM knowledge_proposals")).toBe(proposalCount);
    expect(scalar(databasePath, "SELECT COUNT(*) count FROM knowledge_commit_receipts")).toBe(1);
    expect((await readdir(targetDirectory)).filter((name) => /\.(?:tmp|backup|displaced)-/.test(name))).toEqual([]);
  }, 60_000);

  it("restores the original artifact when an asynchronous post-install readback fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-knowledge-readback-"));
    const target = path.join(root, "note.md");
    await writeFile(target, "original", "utf8");
    await expect(writeArtifactSetAtomic(root, [{ path: target, content: "candidate" }], async () => {
      await Promise.resolve();
      throw new Error("readback failed");
    })).rejects.toThrow("readback failed");
    expect(await readFile(target, "utf8")).toBe("original");
  });

  it("checks the actual install-time preimage and never clobbers a competing file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-knowledge-cas-"));
    const changed = path.join(root, "changed.md");
    const appeared = path.join(root, "appeared.md");
    const cleanupBlocked = path.join(root, "cleanup-blocked.md");
    const raced = path.join(root, "raced.md");
    let callbacks = 0;

    await writeFile(changed, "human edit B\n", "utf8");
    await expect(writeArtifactConditionalAtomic(
      root,
      { path: changed, content: "candidate C\n", expectedHash: sha256("reviewed A\n") },
      () => { callbacks += 1; },
    )).rejects.toThrow("preimage hash mismatch");
    expect(await readFile(changed, "utf8")).toBe("human edit B\n");

    await writeFile(appeared, "competing file\n", "utf8");
    await expect(writeArtifactConditionalAtomic(
      root,
      { path: appeared, content: "candidate C\n", expectedHash: ABSENT_TARGET_HASH },
      () => { callbacks += 1; },
    )).rejects.toThrow("refusing to clobber");
    expect(await readFile(appeared, "utf8")).toBe("competing file\n");
    expect(callbacks).toBe(0);

    await writeFile(cleanupBlocked, "reviewed A\n", "utf8");
    let cleanupRecoveryError: unknown;
    let retainedCleanupTemporary: string | undefined;
    try {
      await writeArtifactConditionalAtomic(
        root,
        { path: cleanupBlocked, content: "candidate C\n", expectedHash: sha256("reviewed A\n") },
        () => { callbacks += 1; },
        async () => {
          const temporaryName = (await readdir(root)).find((name) => name.startsWith("cleanup-blocked.md.tmp-"));
          if (!temporaryName) throw new Error("temporary artifact was not found");
          retainedCleanupTemporary = temporaryName;
          const temporaryPath = path.join(root, temporaryName);
          await rm(temporaryPath);
          await mkdir(temporaryPath);
          await writeFile(path.join(temporaryPath, "retained.txt"), "retain", "utf8");
          throw new Error("forced pre-install failure");
        },
      );
    } catch (error) {
      cleanupRecoveryError = error;
    }
    expect(cleanupRecoveryError).toBeInstanceOf(RecoveryIncompleteError);
    expect((cleanupRecoveryError as RecoveryIncompleteError).recovery).toMatchObject({
      status: "INCOMPLETE",
      paths: [
        { role: "target", path: cleanupBlocked, observed: "file", action: "PRESERVE" },
        { role: "backup", observed: "absent", action: "NONE" },
        { role: "displaced", observed: "absent", action: "NONE" },
        { role: "temporary", observed: "directory", action: "PRESERVE" },
      ],
    });
    expect(await readFile(cleanupBlocked, "utf8")).toBe("reviewed A\n");
    expect((await readdir(root)).filter((name) => name.startsWith("cleanup-blocked.md.backup-"))).toEqual([]);
    expect(callbacks).toBe(0);

    await writeFile(raced, "reviewed A\n", "utf8");
    let recoveryError: unknown;
    try {
      await writeArtifactConditionalAtomic(
        root,
        { path: raced, content: "candidate C\n", expectedHash: sha256("reviewed A\n") },
        () => { callbacks += 1; },
        async () => { await writeFile(raced, "human edit B\n", "utf8"); },
      );
    } catch (error) {
      recoveryError = error;
    }
    expect(recoveryError).toBeInstanceOf(RecoveryIncompleteError);
    (recoveryError as RecoveryIncompleteError).attachContext({
      command: "knowledge commit",
      proposalId: "KNP-TEST",
      receiptStatus: "ABSENT",
    });
    expect(serializeCommandError(recoveryError)).toEqual({
      command: "knowledge commit",
      error: {
        code: "RECOVERY_INCOMPLETE",
        message: "Conditional artifact write failed and recovery was incomplete",
        retryable: false,
        proposalId: "KNP-TEST",
        receiptStatus: "ABSENT",
        recovery: {
          status: "INCOMPLETE",
          paths: [
            { role: "target", path: raced, observed: "file", action: "PRESERVE" },
            { role: "backup", path: expect.stringMatching(`${raced.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.backup-`), observed: "file", action: "PRESERVE" },
            { role: "displaced", path: expect.stringContaining(`${raced}.displaced-`), observed: "absent", action: "NONE" },
            { role: "temporary", path: expect.stringContaining(`${raced}.tmp-`), observed: "absent", action: "NONE" },
          ],
        },
      },
    });
    expect(await readFile(raced, "utf8")).toBe("human edit B\n");
    const recovery = (await readdir(root)).find((name) => name.startsWith("raced.md.backup-"));
    expect(recovery).toBeDefined();
    expect(await readFile(path.join(root, recovery!), "utf8")).toBe("reviewed A\n");
    expect((await readdir(root)).filter((name) => /\.(?:tmp|displaced)-/.test(name))).toEqual([retainedCleanupTemporary]);
    expect(callbacks).toBe(0);
  });
});
