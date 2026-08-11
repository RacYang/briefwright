import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { prepareSafeFilePathSync } from "../config/paths.js";
import { canonicalJson, configDigest } from "../config/load.js";
import type { EffectiveConfig } from "../config/types.js";
import type { PolicyDefinition } from "../config/types.js";
import type { RunResult } from "../core/types.js";
import type { BriefingItem, Receipt } from "../core/types.js";
import type { CaptureEnvelope } from "../connectors/types.js";
import { countReceipts, runOutcome } from "../core/accounting.js";
import { databaseMigrationStatus, migrateDatabase } from "./migrations.js";

export class SqliteStateStore {
  readonly database: DatabaseSync;

  constructor(databasePath: string, projectRoot: string) {
    prepareSafeFilePathSync(projectRoot, databasePath);
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA foreign_keys = ON");
    const status = databaseMigrationStatus(this.database);
    if (status.current === 0) {
      migrateDatabase(this.database, { databasePath, write: true, backup: false });
    } else if (status.pending.length > 0) {
      throw new Error(`Database schema ${status.current} requires migration to ${status.latest}. Run 'briefwright db migrate --write'.`);
    }
  }

  assertRunWritable(result: RunResult): void {
    const existing = this.database
      .prepare("SELECT config_digest FROM runs WHERE run_id = ?")
      .get(result.runId) as { config_digest: string } | undefined;
    if (existing && existing.config_digest !== result.configDigest) {
      throw new Error(
        `Run ${result.runId} already exists with a different configuration digest; choose a new run ID`,
      );
    }
    if (existing) throw new Error(`Run ${result.runId} is already finalized and cannot be changed`);
  }

  runRecord(runId: string): { status: string; configDigest: string; result: RunResult | null } | null {
    const row = this.database.prepare("SELECT status, config_digest, result_json FROM runs WHERE run_id=?").get(runId) as
      { status: string; config_digest: string; result_json: string | null } | undefined;
    return row ? { status: row.status, configDigest: row.config_digest, result: row.result_json ? JSON.parse(row.result_json) as RunResult : null } : null;
  }

  runArtifacts(runId: string): Array<{ kind: string; path: string; contentHash: string }> {
    return (this.database.prepare("SELECT kind,path,content_hash FROM output_artifacts WHERE run_id=? ORDER BY kind").all(runId) as Array<{ kind: string; path: string; content_hash: string }>).map((row) => ({ kind: row.kind, path: row.path, contentHash: row.content_hash }));
  }

  failFormalRun(runId: string, now: string, stage: string, detail: string): void {
    this.database.prepare("UPDATE runs SET status='failed',completed_at=?,current_stage=? WHERE run_id=?").run(now, stage, runId);
    this.appendEvent(runId, now, stage, "run.failed", "run", runId, `${runId}:terminal:failed`, { detail });
  }

  beginFormalRun(config: EffectiveConfig, runId: string, now: string, executionPlan: unknown): "created" | "resumed" | "complete" {
    const existing = this.runRecord(runId);
    if (existing) {
      if (existing.configDigest !== configDigest(config)) throw new Error(`Run ${runId} already exists with a different configuration digest`);
      if (["success", "partial", "failed"].includes(existing.status) && existing.result) return "complete";
      return "resumed";
    }
    const digest = configDigest(config);
    const policyDigest = hashJson(config.policy);
    const promptDigest = hashJson(config.prompts);
    const sourceDigest = hashJson(config.preset.sources);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("INSERT OR IGNORE INTO config_snapshots(digest,config_json,created_at) VALUES (?,?,?)")
        .run(digest, JSON.stringify(config), now);
      this.database.prepare(`INSERT INTO runs(
        run_id,generated_at,mode,config_digest,status,result_json,started_at,run_kind,current_stage,
        policy_digest,prompt_digest,source_digest,execution_plan_json
      ) VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,?)`).run(
        runId, now, "live", digest, "running", now, "formal", "initialize",
        policyDigest, promptDigest, sourceDigest, JSON.stringify(executionPlan),
      );
      this.database.exec("COMMIT");
      return "created";
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  freezeDueSources(runId: string, sources: EffectiveConfig["preset"]["sources"], reason = "scheduled"): void {
    const statement = this.database.prepare(`INSERT OR IGNORE INTO due_sources(run_id,source_id,ordinal,reason,source_snapshot_json) VALUES (?,?,?,?,?)`);
    sources.forEach((source, index) => statement.run(runId, source.id, index, reason, JSON.stringify(source)));
  }

  dueSources(sources: EffectiveConfig["preset"]["sources"], now: Date): Array<{ source: EffectiveConfig["preset"]["sources"][number]; reason: string }> {
    return sources.flatMap((source) => {
      const row = this.database.prepare(`SELECT c.last_scan_at,s.cadence_hours,s.human_locked
        FROM (SELECT ? AS source_id) x LEFT JOIN source_cursors c ON c.source_id=x.source_id
        LEFT JOIN source_settings s ON s.source_id=x.source_id`).get(source.id) as { last_scan_at: string | null; cadence_hours: number | null; human_locked: number | null };
      if (!row.last_scan_at) return [{ source, reason: "never-scanned" }];
      const cadence = row.cadence_hours ?? source.cadence?.defaultHours ?? 24;
      const next = new Date(row.last_scan_at).getTime() + cadence * 3_600_000;
      return now.getTime() >= next ? [{ source, reason: "next-scan-due" }] : [];
    });
  }

  dueSourceIds(runId: string): string[] {
    return (this.database.prepare("SELECT source_id FROM due_sources WHERE run_id=? ORDER BY ordinal").all(runId) as Array<{ source_id: string }>).map((row) => row.source_id);
  }

  existingReceipts(runId: string): Receipt[] {
    return (this.database.prepare("SELECT source_id,result,detail FROM receipts WHERE run_id=? ORDER BY source_id").all(runId) as Array<{ source_id: string; result: Receipt["result"]; detail: string | null }>).map((row) => ({ sourceId: row.source_id, result: row.result, ...(row.detail ? { detail: row.detail } : {}) }));
  }

  recordStage(runId: string, stage: string, ordinal: number, status: "running" | "complete" | "failed", now: string, detail?: unknown): void {
    this.database.prepare(`INSERT INTO execution_stages(run_id,stage,ordinal,status,started_at,completed_at,detail_json)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(run_id,stage) DO UPDATE SET status=excluded.status,
      started_at=COALESCE(execution_stages.started_at,excluded.started_at),completed_at=excluded.completed_at,detail_json=excluded.detail_json`)
      .run(runId, stage, ordinal, status, now, status === "running" ? null : now, detail === undefined ? null : JSON.stringify(detail));
    this.database.prepare("UPDATE runs SET current_stage=? WHERE run_id=?").run(stage, runId);
    this.appendEvent(runId, now, stage, `stage.${status}`, "run", runId, `${runId}:${stage}:${status}`, detail ?? {});
  }

  appendEvent(runId: string, now: string, stage: string, eventType: string, entityType: string | null, entityId: string | null, idempotencyKey: string, payload: unknown): void {
    const payloadJson = JSON.stringify(payload);
    this.database.prepare(`INSERT OR IGNORE INTO events(event_id,run_id,occurred_at,stage,event_type,entity_type,entity_id,idempotency_key,payload_fingerprint,payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        `EVT-${randomUUID()}`, runId, now, stage, eventType, entityType, entityId, idempotencyKey,
        createHash("sha256").update(payloadJson).digest("hex"), payloadJson,
      );
  }

  sourceCursor(sourceId: string): Record<string, unknown> {
    const row = this.database.prepare("SELECT cursor_json FROM source_cursors WHERE source_id=?").get(sourceId) as { cursor_json: string } | undefined;
    return row ? JSON.parse(row.cursor_json) as Record<string, unknown> : {};
  }

  recordSourceResult(runId: string, receipt: Receipt, captures: CaptureEnvelope[], cursor: Record<string, unknown>, now: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`INSERT INTO receipts(run_id,source_id,result,detail,attempted_at,completed_at,attempts,capture_count,error_code)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,source_id) DO NOTHING`).run(
          runId, receipt.sourceId, receipt.result, receipt.detail ?? null, now, now, 1, captures.length,
          receipt.result === "failed" ? "CAPTURE_FAILED" : null,
        );
      const captureStatement = this.database.prepare(`INSERT OR IGNORE INTO captures(
        capture_id,run_id,source_id,external_key,canonical_url,title,summary,published_at,captured_at,content_hash,evidence_class,raw_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const capture of captures) {
        const captureId = `CAP-${createHash("sha256").update(`${capture.sourceId}\n${capture.externalKey}\n${capture.contentHash}`).digest("hex").slice(0, 20).toUpperCase()}`;
        captureStatement.run(captureId, runId, capture.sourceId, capture.externalKey, capture.canonicalUrl, capture.title, capture.summary,
          capture.publishedAt ?? null, capture.capturedAt, capture.contentHash, capture.evidenceClass, JSON.stringify(capture));
        this.database.prepare("INSERT OR IGNORE INTO capture_observations(run_id,capture_id,observed_at,changed) VALUES (?,?,?,?)")
          .run(runId, captureId, now, receipt.result === "updated" ? 1 : 0);
      }
      if (receipt.result !== "failed" && receipt.result !== "skipped") {
        const previous = this.sourceCursor(receipt.sourceId);
        const priorEffective = this.database.prepare("SELECT last_effective_update_at FROM source_cursors WHERE source_id=?").get(receipt.sourceId) as { last_effective_update_at: string | null } | undefined;
        this.database.prepare(`INSERT INTO source_cursors(source_id,cursor_json,last_scan_at,last_success_at,last_effective_update_at,updated_at)
          VALUES (?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET cursor_json=excluded.cursor_json,last_scan_at=excluded.last_scan_at,
          last_success_at=excluded.last_success_at,last_effective_update_at=excluded.last_effective_update_at,updated_at=excluded.updated_at`).run(
            receipt.sourceId, JSON.stringify({ ...previous, ...cursor }), now, now,
            receipt.result === "updated" ? now : priorEffective?.last_effective_update_at ?? null, now,
          );
      } else {
        this.database.prepare(`INSERT INTO source_cursors(source_id,cursor_json,last_scan_at,last_success_at,last_effective_update_at,updated_at)
          VALUES (?,?,?,NULL,NULL,?) ON CONFLICT(source_id) DO UPDATE SET last_scan_at=excluded.last_scan_at,updated_at=excluded.updated_at`)
          .run(receipt.sourceId, JSON.stringify(cursor), now, now);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  runCaptures(runId: string): CaptureEnvelope[] {
    return (this.database.prepare("SELECT raw_json FROM captures WHERE run_id=? ORDER BY source_id,captured_at,external_key").all(runId) as Array<{ raw_json: string }>).map((row) => JSON.parse(row.raw_json) as CaptureEnvelope);
  }

  finishFormalRun(config: EffectiveConfig, result: RunResult, items: BriefingItem[], artifacts: Array<{ kind: string; path: string; contentHash: string }>, status: "success" | "partial" | "failed"): void {
    const captures = this.database.prepare("SELECT capture_id,canonical_url FROM captures WHERE run_id=?").all(result.runId) as Array<{ capture_id: string; canonical_url: string }>;
    const captureByUrl = new Map(captures.map((row) => [row.canonical_url, row.capture_id]));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const itemStatement = this.database.prepare(`INSERT OR REPLACE INTO items(item_id,run_id,capture_id,canonical_identity,title,summary,why_it_matters,domain,evidence_status,evidence_json,analysis_json,score,disposition,exclusion_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const scoreStatement = this.database.prepare(`INSERT OR REPLACE INTO item_scores(item_id,dimension,raw_score,weight,weighted_score,reason) VALUES (?,?,?,?,?,?)`);
      for (const item of items) {
        const captureId = captureByUrl.get(item.url);
        if (!captureId) continue;
        itemStatement.run(item.id, result.runId, captureId, item.id, item.title, item.summary, item.whyItMatters, item.domain ?? "unknown",
          item.evidenceStatus ?? item.evidence, JSON.stringify({ status: item.evidenceStatus, url: item.url, claims: item.claims ?? [] }), JSON.stringify(item),
          item.score, item.disposition ?? "machine-only", item.exclusionReasons?.join(",") ?? null);
        for (const [dimension, score] of Object.entries(item.scoreDimensions ?? {})) scoreStatement.run(item.id, dimension, score.value, score.weight, score.weighted, score.reason);
      }
      const artifactStatement = this.database.prepare("INSERT OR REPLACE INTO output_artifacts(run_id,kind,path,content_hash) VALUES (?,?,?,?)");
      for (const artifact of artifacts) artifactStatement.run(result.runId, artifact.kind, artifact.path, artifact.contentHash);
      this.database.prepare("UPDATE runs SET status='finalizing',result_json=?,current_stage='persist' WHERE run_id=?")
        .run(JSON.stringify(result), result.runId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  finalizeFormalRun(runId: string, status: "success" | "partial" | "failed", now = new Date().toISOString()): void {
    this.database.prepare("UPDATE runs SET status=?,completed_at=?,current_stage='complete' WHERE run_id=? AND status IN ('running','finalizing')")
      .run(status, now, runId);
  }

  updateRunResult(result: RunResult): void {
    this.database.prepare("UPDATE runs SET result_json=? WHERE run_id=?").run(JSON.stringify(result), result.runId);
  }

  addFeedback(itemId: string, type: "reviewed" | "used" | "ignored" | "knowledge-worthy", note: string | undefined, now = new Date().toISOString()): { feedbackId: string; runId: string } {
    const item = this.database.prepare("SELECT run_id FROM items WHERE item_id=?").get(itemId) as { run_id: string } | undefined;
    if (!item) throw new Error(`Item not found: ${itemId}`);
    const feedbackId = `FDB-${randomUUID()}`;
    this.database.prepare("INSERT INTO feedback(feedback_id,item_id,run_id,feedback_type,note,created_at) VALUES (?,?,?,?,?,?)")
      .run(feedbackId, itemId, item.run_id, type, note ?? null, now);
    return { feedbackId, runId: item.run_id };
  }

  feedbackSummary(): { total: number; reviewedItems: number; firstAt: string | null; lastAt: string | null; byType: Record<string, number> } {
    const rows = this.database.prepare("SELECT feedback_type,COUNT(*) count FROM feedback GROUP BY feedback_type").all() as Array<{ feedback_type: string; count: number }>;
    const range = this.database.prepare("SELECT COUNT(DISTINCT item_id) reviewed,MIN(created_at) first_at,MAX(created_at) last_at FROM feedback").get() as { reviewed: number; first_at: string | null; last_at: string | null };
    return { total: rows.reduce((sum, row) => sum + row.count, 0), reviewedItems: range.reviewed, firstAt: range.first_at, lastAt: range.last_at, byType: Object.fromEntries(rows.map((row) => [row.feedback_type, row.count])) };
  }

  createExperiment(policy: PolicyDefinition, baselineDigest: string, now = new Date().toISOString()): string {
    const id = `EXP-${randomUUID()}`;
    this.database.prepare(`INSERT INTO experiments(experiment_id,status,baseline_policy_digest,candidate_policy_json,created_at) VALUES (?,?,?,?,?)`)
      .run(id, "candidate", baselineDigest, JSON.stringify(policy), now);
    return id;
  }

  experiment(id: string): { id: string; status: string; policy: PolicyDefinition; metrics: unknown } {
    const row = this.database.prepare("SELECT status,candidate_policy_json,metrics_json FROM experiments WHERE experiment_id=?").get(id) as { status: string; candidate_policy_json: string; metrics_json: string | null } | undefined;
    if (!row) throw new Error(`Experiment not found: ${id}`);
    return { id, status: row.status, policy: JSON.parse(row.candidate_policy_json) as PolicyDefinition, metrics: row.metrics_json ? JSON.parse(row.metrics_json) : null };
  }

  evaluateExperiment(id: string, now = new Date()): { eligible: boolean; metrics: Record<string, unknown> } {
    const experiment = this.experiment(id);
    if (experiment.status !== "candidate" && experiment.status !== "evaluated") throw new Error(`Experiment ${id} cannot be evaluated from status ${experiment.status}`);
    const feedback = this.feedbackSummary();
    const spanDays = feedback.firstAt && feedback.lastAt ? Math.floor((new Date(feedback.lastAt).getTime() - new Date(feedback.firstAt).getTime()) / 86_400_000) : 0;
    const rows = this.database.prepare(`SELECT i.item_id,i.disposition,s.dimension,s.raw_score FROM items i JOIN item_scores s ON s.item_id=i.item_id ORDER BY i.run_id DESC`).all() as Array<{ item_id: string; disposition: string; dimension: string; raw_score: number }>;
    const grouped = new Map<string, Array<{ dimension: string; raw: number }>>();
    for (const row of rows) grouped.set(row.item_id, [...(grouped.get(row.item_id) ?? []), { dimension: row.dimension, raw: row.raw_score }]);
    let candidateDaily = 0;
    let candidateReview = 0;
    for (const scores of grouped.values()) {
      const total = experiment.policy.score.dimensions.reduce((sum, definition) => sum + (scores.find((score) => score.dimension === definition.id)?.raw ?? 0) / 5 * 100 * definition.weight, 0);
      if (total >= experiment.policy.score.dailyThreshold) candidateDaily += 1;
      else if (total >= experiment.policy.score.reviewMinimum) candidateReview += 1;
    }
    const eligible = feedback.reviewedItems >= 50 && spanDays >= 14;
    const metrics = { evaluatedAt: now.toISOString(), eligible, reviewedItems: feedback.reviewedItems, spanDays, baselineItems: grouped.size, candidateDaily, candidateReview, feedbackByType: feedback.byType };
    this.database.prepare("UPDATE experiments SET status=?,sample_json=?,metrics_json=? WHERE experiment_id=?")
      .run(eligible ? "evaluated" : "candidate", JSON.stringify({ reviewedItems: feedback.reviewedItems, spanDays }), JSON.stringify(metrics), id);
    return { eligible, metrics };
  }

  transitionExperiment(id: string, action: "approve" | "activate" | "rollback", now = new Date().toISOString()): { status: string; policy: PolicyDefinition } {
    const current = this.experiment(id);
    const allowed: Record<typeof action, string[]> = { approve: ["evaluated"], activate: ["approved"], rollback: ["active"] };
    if (!allowed[action].includes(current.status)) throw new Error(`Experiment ${id} cannot ${action} from status ${current.status}`);
    const status = action === "approve" ? "approved" : action === "activate" ? "active" : "rolled-back";
    const column = action === "approve" ? "approved_at" : action === "activate" ? "activated_at" : "rolled_back_at";
    this.database.prepare(`UPDATE experiments SET status=?,${column}=? WHERE experiment_id=?`).run(status, now, id);
    return { status, policy: current.policy };
  }

  createKnowledgeProposal(itemId: string, targetPath: string, targetHeading: string | undefined, expectedTargetHash: string | undefined, content: string, now = new Date().toISOString()): string {
    const item = this.database.prepare("SELECT 1 FROM items WHERE item_id=?").get(itemId);
    if (!item) throw new Error(`Item not found: ${itemId}`);
    const id = `KNP-${randomUUID()}`;
    this.database.prepare(`INSERT INTO knowledge_proposals(proposal_id,item_id,status,target_path,target_heading,expected_target_hash,content,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, itemId, "proposed", targetPath, targetHeading ?? null, expectedTargetHash ?? null, content, now);
    return id;
  }

  knowledgeProposal(id: string): { id: string; itemId: string; status: string; targetPath: string; targetHeading?: string; expectedTargetHash?: string; content: string } {
    const row = this.database.prepare(`SELECT item_id,status,target_path,target_heading,expected_target_hash,content FROM knowledge_proposals WHERE proposal_id=?`).get(id) as
      { item_id: string; status: string; target_path: string; target_heading: string | null; expected_target_hash: string | null; content: string } | undefined;
    if (!row) throw new Error(`Knowledge proposal not found: ${id}`);
    return { id, itemId: row.item_id, status: row.status, targetPath: row.target_path, ...(row.target_heading ? { targetHeading: row.target_heading } : {}), ...(row.expected_target_hash ? { expectedTargetHash: row.expected_target_hash } : {}), content: row.content };
  }

  itemForKnowledge(itemId: string): BriefingItem {
    const row = this.database.prepare("SELECT analysis_json FROM items WHERE item_id=?").get(itemId) as { analysis_json: string } | undefined;
    if (!row) throw new Error(`Item not found: ${itemId}`);
    return JSON.parse(row.analysis_json) as BriefingItem;
  }

  markKnowledgeCommitted(id: string, now = new Date().toISOString()): void {
    const changed = this.database.prepare("UPDATE knowledge_proposals SET status='committed',committed_at=? WHERE proposal_id=? AND status='proposed'").run(now, id);
    if (changed.changes !== 1) throw new Error(`Knowledge proposal ${id} is not in proposed state`);
  }

  recordSchedule(adapter: string, expression: string, projectRoot: string, definition: string, now = new Date().toISOString()): string {
    const id = `SCH-${createHash("sha256").update(projectRoot).digest("hex").slice(0, 16)}`;
    this.database.prepare(`INSERT INTO schedule_installations(schedule_id,adapter,expression,project_root,installed_definition,installed_at,disabled_at)
      VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(schedule_id) DO UPDATE SET adapter=excluded.adapter,expression=excluded.expression,
      installed_definition=excluded.installed_definition,installed_at=excluded.installed_at,disabled_at=NULL`)
      .run(id, adapter, expression, projectRoot, definition, now);
    return id;
  }

  activeSchedule(): { id: string; adapter: string; expression: string; installedAt: string } | null {
    const row = this.database.prepare("SELECT schedule_id,adapter,expression,installed_at FROM schedule_installations WHERE disabled_at IS NULL ORDER BY installed_at DESC LIMIT 1").get() as { schedule_id: string; adapter: string; expression: string; installed_at: string } | undefined;
    return row ? { id: row.schedule_id, adapter: row.adapter, expression: row.expression, installedAt: row.installed_at } : null;
  }

  disableSchedule(id: string, now = new Date().toISOString()): void {
    this.database.prepare("UPDATE schedule_installations SET disabled_at=? WHERE schedule_id=? AND disabled_at IS NULL").run(now, id);
  }

  sourceCadenceMetrics(sourceId: string, since: string): { successes: number; failures: number; selections: number; firstReceiptAt: string | null; currentHours: number | null; humanLocked: boolean } {
    const receipts = this.database.prepare(`SELECT
      SUM(CASE WHEN result IN ('updated','unchanged','observed') THEN 1 ELSE 0 END) successes,
      SUM(CASE WHEN result='failed' THEN 1 ELSE 0 END) failures,MIN(attempted_at) first_at
      FROM receipts WHERE source_id=? AND COALESCE(attempted_at,'')>=?`).get(sourceId, since) as { successes: number | null; failures: number | null; first_at: string | null };
    const selected = this.database.prepare(`SELECT COUNT(*) count FROM items i JOIN runs r ON r.run_id=i.run_id
      WHERE i.capture_id IN (SELECT capture_id FROM captures WHERE source_id=?) AND i.disposition IN ('daily','review') AND r.generated_at>=?`).get(sourceId, since) as { count: number };
    const settings = this.database.prepare("SELECT cadence_hours,human_locked FROM source_settings WHERE source_id=?").get(sourceId) as { cadence_hours: number; human_locked: number } | undefined;
    return { successes: receipts.successes ?? 0, failures: receipts.failures ?? 0, selections: selected.count, firstReceiptAt: receipts.first_at, currentHours: settings?.cadence_hours ?? null, humanLocked: settings?.human_locked === 1 };
  }

  createCadenceProposal(sourceId: string, currentHours: number, proposedHours: number, reason: string, metrics: unknown, now: string): string | null {
    const open = this.database.prepare("SELECT 1 FROM cadence_proposals WHERE source_id=? AND status='proposed'").get(sourceId);
    if (open) return null;
    const id = `CAD-${randomUUID()}`;
    this.database.prepare(`INSERT INTO cadence_proposals(proposal_id,source_id,current_hours,proposed_hours,reason,metrics_json,status,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, sourceId, currentHours, proposedHours, reason, JSON.stringify(metrics), "proposed", now);
    return id;
  }

  cadenceProposals(): Array<{ id: string; sourceId: string; currentHours: number; proposedHours: number; reason: string; status: string }> {
    return (this.database.prepare("SELECT proposal_id,source_id,current_hours,proposed_hours,reason,status FROM cadence_proposals ORDER BY created_at DESC").all() as Array<{ proposal_id: string; source_id: string; current_hours: number; proposed_hours: number; reason: string; status: string }>).map((row) => ({ id: row.proposal_id, sourceId: row.source_id, currentHours: row.current_hours, proposedHours: row.proposed_hours, reason: row.reason, status: row.status }));
  }

  decideCadenceProposal(id: string, decision: "approve" | "reject", now = new Date().toISOString()): void {
    const row = this.database.prepare("SELECT source_id,proposed_hours,status FROM cadence_proposals WHERE proposal_id=?").get(id) as { source_id: string; proposed_hours: number; status: string } | undefined;
    if (!row) throw new Error(`Cadence proposal not found: ${id}`);
    if (row.status !== "proposed") throw new Error(`Cadence proposal ${id} is already ${row.status}`);
    if (decision === "approve") this.database.prepare(`INSERT INTO source_settings(source_id,cadence_hours,human_locked,updated_at) VALUES (?,?,0,?)
      ON CONFLICT(source_id) DO UPDATE SET cadence_hours=excluded.cadence_hours,updated_at=excluded.updated_at`).run(row.source_id, row.proposed_hours, now);
    this.database.prepare("UPDATE cadence_proposals SET status=?,decided_at=? WHERE proposal_id=?").run(decision === "approve" ? "approved" : "rejected", now, id);
  }

  setSourceCadenceLock(sourceId: string, locked: boolean, defaultHours: number, now = new Date().toISOString()): void {
    this.database.prepare(`INSERT INTO source_settings(source_id,cadence_hours,human_locked,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET human_locked=excluded.human_locked,updated_at=excluded.updated_at`).run(sourceId, defaultHours, locked ? 1 : 0, now);
  }

  saveRun(
    config: EffectiveConfig,
    result: RunResult,
    artifact?: { kind: string; path: string; contentHash: string },
  ): void {
    const outcome = runOutcome(countReceipts(config.preset.sources.map((source) => source.id), result.receipts));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.assertRunWritable(result);

      this.database.prepare(`
        INSERT INTO config_snapshots (digest, config_json, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(digest) DO NOTHING
      `).run(result.configDigest, JSON.stringify(config), result.generatedAt);

      this.database.prepare(`
        INSERT INTO runs (run_id, generated_at, mode, config_digest, status, result_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(result.runId, result.generatedAt, result.mode, result.configDigest, outcome, JSON.stringify(result));

      const receiptStatement = this.database.prepare(`
        INSERT INTO receipts (run_id, source_id, result, detail)
        VALUES (?, ?, ?, ?)
      `);
      for (const receipt of result.receipts) {
        receiptStatement.run(result.runId, receipt.sourceId, receipt.result, receipt.detail ?? null);
      }
      if (artifact) {
        this.database.prepare(`
          INSERT INTO output_artifacts (run_id, kind, path, content_hash)
          VALUES (?, ?, ?, ?)
        `).run(result.runId, artifact.kind, artifact.path, artifact.contentHash);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  latestRun(): {
    runId: string;
    generatedAt: string;
    mode: string;
    status: string;
    artifactPath: string | null;
    updated: number;
    observed: number;
    unchanged: number;
    failed: number;
    skipped: number;
  } | null {
    const row = this.database.prepare(`
      SELECT
        runs.run_id,
        runs.generated_at,
        runs.mode,
        runs.status,
        output_artifacts.path AS artifact_path,
        SUM(CASE WHEN receipts.result = 'updated' THEN 1 ELSE 0 END) AS updated,
        SUM(CASE WHEN receipts.result = 'observed' THEN 1 ELSE 0 END) AS observed,
        SUM(CASE WHEN receipts.result = 'unchanged' THEN 1 ELSE 0 END) AS unchanged,
        SUM(CASE WHEN receipts.result = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN receipts.result = 'skipped' THEN 1 ELSE 0 END) AS skipped
      FROM runs
      LEFT JOIN receipts ON receipts.run_id = runs.run_id
      LEFT JOIN output_artifacts
        ON output_artifacts.run_id = runs.run_id AND output_artifacts.kind = (
          SELECT kind FROM output_artifacts candidate WHERE candidate.run_id=runs.run_id
          ORDER BY CASE candidate.kind WHEN 'daily-markdown' THEN 0 WHEN 'preview-markdown' THEN 1 ELSE 2 END LIMIT 1
        )
      GROUP BY runs.run_id
      ORDER BY runs.generated_at DESC
      LIMIT 1
    `).get() as {
      run_id: string;
      generated_at: string;
      mode: string;
      status: string;
      artifact_path: string | null;
      updated: number;
      observed: number;
      unchanged: number;
      failed: number;
      skipped: number;
    } | undefined;
    if (!row) return null;
    return {
      runId: row.run_id,
      generatedAt: row.generated_at,
      mode: row.mode,
      status: row.status,
      artifactPath: row.artifact_path,
      updated: row.updated,
      observed: row.observed,
      unchanged: row.unchanged,
      failed: row.failed,
      skipped: row.skipped,
    };
  }

  replayBundle(runId: string): {
    config: EffectiveConfig;
    result: RunResult;
    artifactPath: string;
    contentHash: string;
  } {
    const row = this.database.prepare(`
      SELECT config_snapshots.config_json, runs.result_json,
             output_artifacts.path, output_artifacts.content_hash
      FROM runs
      JOIN config_snapshots ON config_snapshots.digest = runs.config_digest
      JOIN output_artifacts ON output_artifacts.run_id = runs.run_id
      WHERE runs.run_id = ?
      ORDER BY CASE output_artifacts.kind WHEN 'daily-markdown' THEN 0 WHEN 'preview-markdown' THEN 1 ELSE 2 END
      LIMIT 1
    `).get(runId) as {
      config_json: string;
      result_json: string | null;
      path: string;
      content_hash: string;
    } | undefined;
    if (!row) throw new Error(`Run not found or has no recorded artifact: ${runId}`);
    if (!row.result_json) throw new Error(`Run predates replay snapshots and cannot be reproduced: ${runId}`);
    return {
      config: JSON.parse(row.config_json) as EffectiveConfig,
      result: JSON.parse(row.result_json) as RunResult,
      artifactPath: row.path,
      contentHash: row.content_hash,
    };
  }

  replayArtifacts(runId: string): {
    config: EffectiveConfig;
    result: RunResult;
    artifacts: Array<{ kind: string; path: string; contentHash: string }>;
  } {
    const run = this.database.prepare(`SELECT config_snapshots.config_json,runs.result_json FROM runs
      JOIN config_snapshots ON config_snapshots.digest=runs.config_digest WHERE runs.run_id=?`).get(runId) as { config_json: string; result_json: string | null } | undefined;
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (!run.result_json) throw new Error(`Run predates replay snapshots and cannot be reproduced: ${runId}`);
    const artifacts = this.runArtifacts(runId);
    if (!artifacts.length) throw new Error(`Run has no recorded artifacts: ${runId}`);
    return { config: JSON.parse(run.config_json) as EffectiveConfig, result: JSON.parse(run.result_json) as RunResult, artifacts };
  }

  close(): void {
    this.database.close();
  }
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
