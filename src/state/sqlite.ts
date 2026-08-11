import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { prepareSafeFilePathSync } from "../config/paths.js";
import { canonicalJson, configDigest } from "../config/load.js";
import type { EffectiveConfig } from "../config/types.js";
import type { PolicyDefinition } from "../config/types.js";
import type { RunResult } from "../core/types.js";
import type { BriefingItem, Receipt } from "../core/types.js";
import type { CaptureEnvelope } from "../connectors/types.js";
import type { CanonicalControlRecord } from "../control-plane/types.js";
import { countReceipts, runOutcome } from "../core/accounting.js";
import { replayCandidateUnderPolicy, selectCandidatesUnderPolicy } from "../core/selection.js";
import { databaseMigrationStatus, migrateDatabase } from "./migrations.js";
import type { FeedbackType } from "../commands/feedback.js";

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

  beginFormalRun(config: EffectiveConfig, runId: string, now: string, executionPlan: unknown, parentRunId?: string): "created" | "resumed" | "complete" {
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
        policy_digest,prompt_digest,source_digest,execution_plan_json,parent_run_id
      ) VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,?,?)`).run(
        runId, now, "live", digest, "running", now, parentRunId ? "formal-retry" : "formal", "initialize",
        policyDigest, promptDigest, sourceDigest, JSON.stringify(executionPlan), parentRunId ?? null,
      );
      this.database.exec("COMMIT");
      return "created";
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  retryContext(baseRunId: string, digest: string): { runId: string; parentRunId: string; forcedSourceIds: string[]; resumed: boolean } {
    const rows = this.database.prepare(`SELECT run_id,status,config_digest,result_json FROM runs
      WHERE run_id=? OR run_id LIKE ? ORDER BY run_id DESC`).all(baseRunId, `${baseRunId}-R%`) as Array<{ run_id: string; status: string; config_digest: string; result_json: string | null }>;
    if (!rows.length) throw new Error(`No formal run exists to retry for ${baseRunId}`);
    const latest = rows[0]!;
    if (latest.config_digest !== digest) throw new Error(`The failed run ${latest.run_id} used a different configuration. Restore that configuration or wait for a new scheduled batch.`);
    if (!["success", "partial", "failed"].includes(latest.status) || !latest.result_json) {
      return { runId: latest.run_id, parentRunId: latest.run_id === baseRunId ? baseRunId : (this.database.prepare("SELECT parent_run_id FROM runs WHERE run_id=?").get(latest.run_id) as { parent_run_id: string }).parent_run_id, forcedSourceIds: this.dueSourceIds(latest.run_id), resumed: true };
    }
    if (latest.status === "success") throw new Error(`Run ${latest.run_id} succeeded; there are no failed operations to retry`);
    const result = JSON.parse(latest.result_json) as RunResult;
    const failedSourceIds = result.receipts.filter((receipt) => receipt.result === "failed" || receipt.result === "skipped").map((receipt) => receipt.sourceId);
    const ordinal = rows.filter((row) => row.run_id !== baseRunId).length + 1;
    return { runId: `${baseRunId}-R${String(ordinal).padStart(2, "0")}`, parentRunId: latest.run_id, forcedSourceIds: failedSourceIds, resumed: false };
  }

  freezeDueSources(runId: string, sources: EffectiveConfig["preset"]["sources"], reason = "scheduled"): void {
    const statement = this.database.prepare(`INSERT OR IGNORE INTO due_sources(run_id,source_id,ordinal,reason,source_snapshot_json) VALUES (?,?,?,?,?)`);
    sources.forEach((source, index) => statement.run(runId, source.id, index, reason, JSON.stringify(source)));
  }

  coverageGapDomains(domains: string[], now: Date, windowDays = 30): string[] {
    const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
    const history = this.database.prepare("SELECT MIN(generated_at) first_at FROM runs WHERE run_kind IN ('formal','formal-retry') OR mode='live'").get() as { first_at: string | null };
    if (!history.first_at || new Date(history.first_at).getTime() > new Date(since).getTime()) return [];
    const covered = new Set((this.database.prepare(`SELECT DISTINCT i.domain FROM items i JOIN runs r ON r.run_id=i.run_id
      WHERE r.generated_at>=? AND i.disposition IN ('daily','review')`).all(since) as Array<{ domain: string }>).map((row) => row.domain));
    return domains.filter((domain) => !covered.has(domain));
  }

  dueSources(sources: EffectiveConfig["preset"]["sources"], now: Date, domains: string[] = []): Array<{ source: EffectiveConfig["preset"]["sources"][number]; reason: string }> {
    const coverageGaps = new Set(this.coverageGapDomains(domains, now));
    return sources.flatMap((source) => {
      if (source.enabled === false) return [];
      const sourceGaps = (source.coverageDomains ?? (source.domain ? [source.domain] : [])).filter((domain) => coverageGaps.has(domain));
      if (sourceGaps.length) return [{ source, reason: `coverage-gap:${sourceGaps.sort().join("|")}` }];
      if (source.scheduleState) {
        const remoteNext = source.scheduleState.nextScanAt;
        if (remoteNext) return now.getTime() >= new Date(remoteNext).getTime() ? [{ source, reason: "control-plane-next-scan-due" }] : [];
        if (!source.scheduleState.lastScanAt) return [{ source, reason: "control-plane-never-scanned" }];
      }
      const row = this.database.prepare(`SELECT c.last_scan_at,s.cadence_hours,s.human_locked
        FROM (SELECT ? AS source_id) x LEFT JOIN source_cursors c ON c.source_id=x.source_id
        LEFT JOIN source_settings s ON s.source_id=x.source_id`).get(source.id) as { last_scan_at: string | null; cadence_hours: number | null; human_locked: number | null };
      if (!row.last_scan_at) return [{ source, reason: "never-scanned" }];
      const cadence = row.cadence_hours ?? source.cadence?.defaultHours ?? 24;
      const next = new Date(row.last_scan_at).getTime() + cadence * 3_600_000;
      return now.getTime() >= next ? [{ source, reason: "next-scan-due" }] : [];
    });
  }

  controlRecords(config: EffectiveConfig, runId: string): CanonicalControlRecord[] {
    const rows = <T extends Record<string, unknown>>(sql: string, ...parameters: unknown[]): T[] => this.database.prepare(sql).all(...parameters as never[]) as T[];
    const record = (kind: CanonicalControlRecord["kind"], id: string, payload: Record<string, unknown>, links?: CanonicalControlRecord["links"]): CanonicalControlRecord =>
      ({ kind, id, payload, ...(links && Object.keys(links).length ? { links } : {}) });
    const runRows = rows<Record<string, unknown>>("SELECT * FROM runs WHERE run_id=?", runId);
    const receiptRows = rows<Record<string, unknown>>(`SELECT r.*,d.reason due_reason FROM receipts r LEFT JOIN due_sources d ON d.run_id=r.run_id AND d.source_id=r.source_id WHERE r.run_id=? ORDER BY r.source_id`, runId);
    const captureRows = rows<Record<string, unknown>>("SELECT * FROM captures WHERE run_id=? ORDER BY capture_id", runId);
    const itemRows = rows<Record<string, unknown>>("SELECT * FROM items WHERE run_id=? ORDER BY item_id", runId);
    const eventRows = rows<Record<string, unknown>>("SELECT * FROM events WHERE run_id=? ORDER BY event_id", runId);
    const feedbackRows = rows<Record<string, unknown>>(`SELECT f.* FROM feedback f JOIN items i ON i.item_id=f.item_id WHERE i.run_id=? ORDER BY f.feedback_id`, runId);
    const experimentRows = rows<Record<string, unknown>>("SELECT * FROM experiments ORDER BY experiment_id");
    const workflowRuleIds = config.policy.rules.filter((rule) => rule.id.startsWith("RULE-WORKFLOW-")).map((rule) => rule.id);
    const scoreRuleIds = config.policy.rules.filter((rule) => rule.id.startsWith("RULE-SCORE-")).map((rule) => rule.id);
    const sourceCursorRows = new Map(rows<Record<string, unknown>>("SELECT * FROM source_cursors").map((row) => [String(row.source_id), row]));
    const sourceSettingRows = new Map(rows<Record<string, unknown>>("SELECT * FROM source_settings").map((row) => [String(row.source_id), row]));
    const sourcePayload = (source: EffectiveConfig["preset"]["sources"][number]): Record<string, unknown> => {
      const cursor = sourceCursorRows.get(source.id); const setting = sourceSettingRows.get(source.id);
      if (!cursor && !setting) return source as unknown as Record<string, unknown>;
      const lastScanAt = typeof cursor?.last_scan_at === "string" ? cursor.last_scan_at : source.scheduleState?.lastScanAt;
      const lastSuccessAt = typeof cursor?.last_success_at === "string" ? cursor.last_success_at : source.scheduleState?.lastSuccessAt;
      const lastEffectiveUpdateAt = typeof cursor?.last_effective_update_at === "string" ? cursor.last_effective_update_at : source.scheduleState?.lastEffectiveUpdateAt;
      const cadenceHours = typeof setting?.cadence_hours === "number" ? setting.cadence_hours : source.cadence?.defaultHours ?? 24;
      const nextScanAt = lastScanAt ? new Date(new Date(lastScanAt).getTime() + cadenceHours * 3_600_000).toISOString() : source.scheduleState?.nextScanAt;
      const frequency = cadenceHours <= 24 ? "daily" : cadenceHours <= 168 ? "weekly" : "on-demand";
      return { ...source, cadence: { ...(source.cadence ?? { minimumHours: 6, maximumHours: 2160 }), defaultHours: cadenceHours }, scheduleState: { ...(source.scheduleState ?? {}), frequency,
        ...(typeof setting?.human_locked === "number" ? { humanLocked: setting.human_locked === 1 } : {}), ...(lastScanAt ? { lastScanAt } : {}), ...(lastSuccessAt ? { lastSuccessAt } : {}), ...(lastEffectiveUpdateAt ? { lastEffectiveUpdateAt } : {}), ...(nextScanAt ? { nextScanAt } : {}) } } as unknown as Record<string, unknown>;
    };
    return [
      ...config.preset.sources.map((source) => record("sources", source.id, sourcePayload(source))),
      ...config.policy.rules.map((rule) => record("rules", rule.id, rule as unknown as Record<string, unknown>)),
      ...runRows.map((row) => record("runs", String(row.run_id), row, {
        sources: config.preset.sources.map((source) => source.id), rules: config.policy.rules.map((rule) => rule.id),
        captures: captureRows.map((capture) => String(capture.capture_id)), items: itemRows.map((item) => String(item.item_id)),
        events: eventRows.map((event) => String(event.event_id)), receipts: receiptRows.map((receipt) => `${runId}:${String(receipt.source_id)}`), feedback: feedbackRows.map((feedback) => String(feedback.feedback_id)),
      })),
      ...captureRows.map((row) => record("captures", String(row.capture_id), row, { runs: [runId], sources: [String(row.source_id)], items: itemRows.filter((item) => item.capture_id === row.capture_id).map((item) => String(item.item_id)) })),
      ...itemRows.map((row) => record("items", String(row.item_id), row, { runs: [runId], captures: [String(row.capture_id)], sources: captureRows.filter((capture) => capture.capture_id === row.capture_id).map((capture) => String(capture.source_id)), rules: scoreRuleIds,
        events: eventRows.filter((event) => event.entity_type === "item" && event.entity_id === row.item_id).map((event) => String(event.event_id)) })),
      ...eventRows.map((row) => record("events", String(row.event_id), row, { runs: [runId], rules: workflowRuleIds,
        ...(row.entity_type === "item" && row.entity_id ? { items: [String(row.entity_id)] } : {}) })),
      ...feedbackRows.map((row) => record("feedback", String(row.feedback_id), row, { items: [String(row.item_id)], runs: [runId] })),
      ...experimentRows.map((row) => record("experiments", String(row.experiment_id), row, { rules: config.policy.rules.map((rule) => rule.id) })),
      ...receiptRows.map((row) => {
        const source = config.preset.sources.find((entry) => entry.id === row.source_id);
        const executionChannel = source?.connector.type === "github-releases" ? "GitHub" : source?.connector.type === "x-api" ? "X" : source?.sourceType === "paper" || source?.sourceType === "regulation" ? "论文与监管" : "官网与文档";
        return record("receipts", `${runId}:${String(row.source_id)}`, { ...row, execution_channel: executionChannel }, { runs: [runId], sources: [String(row.source_id)], rules: workflowRuleIds });
      }),
    ];
  }

  dueSourceIds(runId: string): string[] {
    return (this.database.prepare("SELECT source_id FROM due_sources WHERE run_id=? ORDER BY ordinal").all(runId) as Array<{ source_id: string }>).map((row) => row.source_id);
  }

  existingReceipts(runId: string): Receipt[] {
    return (this.database.prepare("SELECT source_id,result,detail,duration_ms FROM receipts WHERE run_id=? ORDER BY source_id").all(runId) as Array<{ source_id: string; result: Receipt["result"]; detail: string | null; duration_ms: number | null }>).map((row) => ({ sourceId: row.source_id, result: row.result, ...(row.detail ? { detail: row.detail } : {}), ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}) }));
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
    const plan = this.database.prepare("SELECT execution_plan_json FROM runs WHERE run_id=?").get(runId) as { execution_plan_json: string | null } | undefined;
    const rules = plan?.execution_plan_json ? (JSON.parse(plan.execution_plan_json) as { rules?: Array<{ id?: string }> }).rules ?? [] : [];
    const ruleIdSnapshot = rules.find((rule) => rule.id?.startsWith("RULE-WORKFLOW-"))?.id;
    const enrichedPayload = payload && typeof payload === "object" && !Array.isArray(payload) ? { ...(payload as Record<string, unknown>), ...(ruleIdSnapshot ? { ruleIdSnapshot } : {}) } : { value: payload, ...(ruleIdSnapshot ? { ruleIdSnapshot } : {}) };
    const payloadJson = JSON.stringify(enrichedPayload);
    const canonicalKey = ruleIdSnapshot ? `${idempotencyKey}:${ruleIdSnapshot}` : idempotencyKey;
    this.database.prepare(`INSERT OR IGNORE INTO events(event_id,run_id,occurred_at,stage,event_type,entity_type,entity_id,idempotency_key,payload_fingerprint,payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        `EVT-${randomUUID()}`, runId, now, stage, eventType, entityType, entityId, canonicalKey,
        createHash("sha256").update(`${ruleIdSnapshot ?? "NO-RULE"}\n${payloadJson}`).digest("hex"), payloadJson,
      );
  }

  sourceCursor(sourceId: string): Record<string, unknown> {
    const row = this.database.prepare("SELECT cursor_json FROM source_cursors WHERE source_id=?").get(sourceId) as { cursor_json: string } | undefined;
    return row ? JSON.parse(row.cursor_json) as Record<string, unknown> : {};
  }

  recordSourceResult(runId: string, receipt: Receipt, captures: CaptureEnvelope[], cursor: Record<string, unknown>, now: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`INSERT INTO receipts(run_id,source_id,result,detail,attempted_at,completed_at,attempts,capture_count,error_code,duration_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,source_id) DO NOTHING`).run(
          runId, receipt.sourceId, receipt.result, receipt.detail ?? null, now, now, 1,
          captures.filter((capture) => capture.fetchStatus !== "failed" && capture.extractStatus !== "failed").length,
          receipt.result === "failed" ? "CAPTURE_FAILED" : null, receipt.durationMs ?? null,
        );
      const captureStatement = this.database.prepare(`INSERT OR IGNORE INTO captures(
        capture_id,run_id,source_id,external_key,canonical_url,title,summary,published_at,captured_at,content_hash,evidence_class,raw_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const capture of captures) {
        const captureId = captureIdentity(capture);
        const { analysisText: _transientAnalysisText, ...persistentCapture } = capture;
        captureStatement.run(captureId, runId, capture.sourceId, capture.externalKey, capture.canonicalUrl, capture.title, capture.summary,
          capture.publishedAt ?? null, capture.capturedAt, capture.contentHash, capture.evidenceClass, JSON.stringify(persistentCapture));
        if (capture.fetchStatus !== "failed" && capture.extractStatus !== "failed") {
          this.database.prepare("INSERT OR IGNORE INTO capture_observations(run_id,capture_id,observed_at,changed) VALUES (?,?,?,?)")
            .run(runId, captureId, now, receipt.result === "updated" ? 1 : 0);
        }
      }
      if (receipt.result === "failed") {
        const failed = captures.find((capture) => capture.fetchStatus === "failed");
        this.appendEvent(runId, now, "capture", "capture.failed", "source", receipt.sourceId, `${runId}:${receipt.sourceId}:capture-failed`, {
          fromState: "已发现", toState: "抓取失败", actor: "采集器", reason: receipt.detail ?? failed?.failureReason ?? "capture failed",
          attempts: failed?.attempts ?? 1, errorCode: "CAPTURE_FAILED",
        });
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
    return (this.database.prepare("SELECT raw_json FROM captures WHERE run_id=? ORDER BY source_id,captured_at,external_key").all(runId) as Array<{ raw_json: string }>)
      .map((row) => JSON.parse(row.raw_json) as CaptureEnvelope)
      .filter((capture) => capture.fetchStatus !== "failed" && capture.extractStatus !== "failed");
  }

  pendingAnalysisWork(limit: number): Array<{ capture: CaptureEnvelope; analysis?: Record<string, unknown> }> {
    return (this.database.prepare(`SELECT c.raw_json,
        (SELECT a.analysis_json FROM analysis_attempts a WHERE a.capture_id=c.capture_id AND a.status='success' AND a.analysis_json IS NOT NULL ORDER BY a.attempted_at DESC LIMIT 1) analysis_json,
        (SELECT MAX(a.attempted_at) FROM analysis_attempts a WHERE a.capture_id=c.capture_id) last_attempt
      FROM captures c
      WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.capture_id=c.capture_id)
        AND NOT EXISTS (SELECT 1 FROM analysis_attempts a WHERE a.capture_id=c.capture_id AND a.status='duplicate')
        AND COALESCE(json_extract(c.raw_json,'$.fetchStatus'),'success') <> 'failed'
        AND COALESCE(json_extract(c.raw_json,'$.extractStatus'),'success') <> 'failed'
      ORDER BY CASE WHEN last_attempt IS NULL THEN 0 ELSE 1 END,last_attempt,c.captured_at,c.capture_id LIMIT ?`).all(limit) as Array<{ raw_json: string; analysis_json: string | null }>).map((row) => ({
        capture: JSON.parse(row.raw_json) as CaptureEnvelope,
        ...(row.analysis_json ? { analysis: JSON.parse(row.analysis_json) as Record<string, unknown> } : {}),
      }));
  }

  pendingAnalysisBacklog(excluded: CaptureEnvelope[]): Array<{ sourceId: string; count: number }> {
    const captureIds = excluded.map(captureIdentity);
    const exclusion = captureIds.length ? `AND c.capture_id NOT IN (${captureIds.map(() => "?").join(",")})` : "";
    return (this.database.prepare(`SELECT c.source_id,COUNT(*) count FROM captures c
      WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.capture_id=c.capture_id)
        AND NOT EXISTS (SELECT 1 FROM analysis_attempts a WHERE a.capture_id=c.capture_id AND a.status='duplicate')
        AND COALESCE(json_extract(c.raw_json,'$.fetchStatus'),'success') <> 'failed'
        AND COALESCE(json_extract(c.raw_json,'$.extractStatus'),'success') <> 'failed'
        ${exclusion}
      GROUP BY c.source_id ORDER BY c.source_id`).all(...captureIds) as Array<{ source_id: string; count: number }>)
      .map((row) => ({ sourceId: row.source_id, count: row.count }));
  }

  recordAnalysisAttempt(runId: string, capture: CaptureEnvelope, status: "success" | "failed" | "duplicate", detail: string | undefined, analysis?: unknown, now = new Date().toISOString(), observation: { durationMs?: number | undefined; inputTokens?: number | undefined; outputTokens?: number | undefined; costUsd?: number | undefined } = {}): void {
    const captureId = captureIdentity(capture);
    this.database.prepare(`INSERT INTO analysis_attempts(run_id,capture_id,status,detail,analysis_json,attempted_at,duration_ms,input_tokens,output_tokens,cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(run_id,capture_id) DO UPDATE SET status=excluded.status,detail=excluded.detail,analysis_json=excluded.analysis_json,attempted_at=excluded.attempted_at,
      duration_ms=excluded.duration_ms,input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cost_usd=excluded.cost_usd`)
      .run(runId, captureId, status, detail ?? null, analysis === undefined ? null : JSON.stringify(analysis), now,
        observation.durationMs ?? null, observation.inputTokens ?? null, observation.outputTokens ?? null, observation.costUsd ?? null);
  }

  recordDuplicateCluster(runId: string, captures: CaptureEnvelope[], winner: CaptureEnvelope, now = new Date().toISOString()): string {
    const identities = captures.map(captureIdentity).sort();
    const clusterId = `DUP-${createHash("sha256").update(identities.join("\n")).digest("hex").slice(0, 20).toUpperCase()}`;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("INSERT OR IGNORE INTO duplicate_clusters(run_id,cluster_id,winner_capture_id,reason) VALUES (?,?,?,?)")
        .run(runId, clusterId, captureIdentity(winner), "same canonical URL, external key, and content hash");
      const insert = this.database.prepare("INSERT OR IGNORE INTO duplicate_cluster_members(run_id,cluster_id,capture_id,is_winner) VALUES (?,?,?,?)");
      for (const capture of captures) {
        insert.run(runId, clusterId, captureIdentity(capture), captureIdentity(capture) === captureIdentity(winner) ? 1 : 0);
        if (captureIdentity(capture) !== captureIdentity(winner)) this.recordAnalysisAttempt(runId, capture, "duplicate", `Duplicate of ${captureIdentity(winner)}`, undefined, now);
      }
      this.database.exec("COMMIT");
      return clusterId;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  existingCaptureForItem(itemId: string): CaptureEnvelope | null {
    const row = this.database.prepare(`SELECT c.raw_json FROM items i JOIN captures c ON c.capture_id=i.capture_id
      WHERE i.item_id=?`).get(itemId) as { raw_json: string } | undefined;
    return row ? JSON.parse(row.raw_json) as CaptureEnvelope : null;
  }

  finishFormalRun(config: EffectiveConfig, result: RunResult, items: BriefingItem[], artifacts: Array<{ kind: string; path: string; contentHash: string }>, status: "success" | "partial" | "failed"): void {
    const captures = this.database.prepare("SELECT capture_id,source_id,content_hash FROM captures").all() as Array<{ capture_id: string; source_id: string; content_hash: string }>;
    const captureByVersion = new Map(captures.map((row) => [`${row.source_id}\n${row.content_hash}`, row.capture_id]));
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const itemStatement = this.database.prepare(`INSERT INTO items(item_id,run_id,capture_id,canonical_identity,title,summary,why_it_matters,domain,evidence_status,evidence_json,analysis_json,score,disposition,exclusion_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const scoreStatement = this.database.prepare(`INSERT OR REPLACE INTO item_scores(item_id,dimension,raw_score,weight,weighted_score,reason) VALUES (?,?,?,?,?,?)`);
      for (const item of items) {
        const captureId = item.captureHash ? captureByVersion.get(`${item.sourceId}\n${item.captureHash}`) : undefined;
        if (!captureId) continue;
        itemStatement.run(item.id, result.runId, captureId, item.id, item.title, item.summary, item.whyItMatters, item.domain ?? "unknown",
          item.evidenceStatus ?? item.evidence, JSON.stringify({ status: item.evidenceStatus, url: item.url, claims: item.claims ?? [] }), JSON.stringify(item),
          item.score, item.disposition ?? "machine-only", item.exclusionReasons?.join(",") ?? null);
        for (const [dimension, score] of Object.entries(item.scoreDimensions ?? {})) scoreStatement.run(item.id, dimension, score.value, score.weight, score.weighted, score.reason);
        const terminal = item.disposition === "daily" ? "已生成简报" : item.disposition === "review" ? "人工复核" : "已淘汰";
        const states = ["无", "已发现", "已抓取", "已标准化", "原文已核验", "已去重", "已评分", ...((item.disposition === "daily" || item.disposition === "review") ? ["已入围"] : []), terminal];
        for (let index = 1; index < states.length; index += 1) {
          const toState = states[index]!;
          const actor = toState === "已发现" || toState === "已抓取" ? "采集器" : toState === "原文已核验" ? "核验器" : toState === "已去重" ? "去重器" : toState === "已评分" ? "评分器" : "编排器";
          const payload = { fromState: states[index - 1], toState, actor, reason: "Briefwright canonical item transition" };
          this.appendEvent(result.runId, result.generatedAt, "item-transition", "item.transition", "item", item.id, `${result.runId}:${item.id}:${index}`, payload);
        }
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

  commitFinalArtifacts(
    result: RunResult,
    artifacts: Array<{ kind: string; contentHash: string }>,
    status: "success" | "partial" | "failed",
    completedAt: string,
  ): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const updateArtifact = this.database.prepare("UPDATE output_artifacts SET content_hash=? WHERE run_id=? AND kind=?");
      for (const artifact of artifacts) {
        const updated = updateArtifact.run(artifact.contentHash, result.runId, artifact.kind);
        if (updated.changes !== 1) throw new Error(`Run ${result.runId} is missing ${artifact.kind}`);
      }
      const updated = this.database.prepare("UPDATE runs SET status=?,completed_at=?,current_stage='complete',result_json=? WHERE run_id=? AND status IN ('running','finalizing')")
        .run(status, completedAt, JSON.stringify(result), result.runId);
      if (updated.changes !== 1) throw new Error(`Run ${result.runId} cannot be finalized from its current state`);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  addFeedback(itemId: string, type: FeedbackType, note: string | undefined, now = new Date().toISOString()): { feedbackId: string; runId: string } {
    const item = this.database.prepare("SELECT run_id FROM items WHERE item_id=?").get(itemId) as { run_id: string } | undefined;
    if (!item) throw new Error(`Item not found: ${itemId}`);
    const feedbackId = `FDB-${randomUUID()}`;
    this.database.prepare("INSERT INTO feedback(feedback_id,item_id,run_id,feedback_type,note,created_at) VALUES (?,?,?,?,?,?)")
      .run(feedbackId, itemId, item.run_id, type, note ?? null, now);
    return { feedbackId, runId: item.run_id };
  }

  importControlFeedback(records: CanonicalControlRecord[]): { imported: number; deferred: number } {
    let imported = 0; let deferred = 0;
    const statement = this.database.prepare("INSERT OR IGNORE INTO feedback(feedback_id,item_id,run_id,feedback_type,note,created_at) VALUES(?,?,?,?,?,?)");
    for (const record of records.filter((entry) => entry.kind === "feedback")) {
      const itemId = record.links?.items?.[0]; if (!itemId) { deferred += 1; continue; }
      const item = this.database.prepare("SELECT run_id FROM items WHERE item_id=?").get(itemId) as { run_id: string } | undefined;
      if (!item) { deferred += 1; continue; }
      const result = statement.run(record.id, itemId, item.run_id, String(record.payload.feedback_type ?? "reviewed"), typeof record.payload.note === "string" ? record.payload.note : null, typeof record.payload.created_at === "string" ? record.payload.created_at : new Date().toISOString());
      imported += Number(result.changes);
    }
    return { imported, deferred };
  }

  importRemoteControlRecords(records: CanonicalControlRecord[], revision: string, now = new Date().toISOString()): number {
    const statement = this.database.prepare(`INSERT INTO remote_control_records(kind,business_id,payload_json,links_json,revision,imported_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(kind,business_id) DO UPDATE SET payload_json=excluded.payload_json,links_json=excluded.links_json,revision=excluded.revision,imported_at=excluded.imported_at`);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const record of records) statement.run(record.kind, record.id, JSON.stringify(record.payload), JSON.stringify(record.links ?? {}), revision, now);
      this.database.exec("COMMIT"); return records.length;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  remoteControlRecords(kind: CanonicalControlRecord["kind"]): CanonicalControlRecord[] {
    return (this.database.prepare("SELECT business_id,payload_json,links_json FROM remote_control_records WHERE kind=? ORDER BY business_id").all(kind) as Array<{ business_id: string; payload_json: string; links_json: string }>).map((row) => {
      const links = JSON.parse(row.links_json) as NonNullable<CanonicalControlRecord["links"]>;
      return { kind, id: row.business_id, payload: JSON.parse(row.payload_json) as Record<string, unknown>, ...(Object.keys(links).length ? { links } : {}) };
    });
  }

  feedbackSummary(): { total: number; reviewedItems: number; firstAt: string | null; lastAt: string | null; byType: Record<string, number> } {
    const rows = this.database.prepare("SELECT feedback_type,COUNT(*) count FROM feedback GROUP BY feedback_type").all() as Array<{ feedback_type: string; count: number }>;
    const range = this.database.prepare("SELECT COUNT(DISTINCT item_id) reviewed,MIN(created_at) first_at,MAX(created_at) last_at FROM feedback").get() as { reviewed: number; first_at: string | null; last_at: string | null };
    return { total: rows.reduce((sum, row) => sum + row.count, 0), reviewedItems: range.reviewed, firstAt: range.first_at, lastAt: range.last_at, byType: Object.fromEntries(rows.map((row) => [row.feedback_type, row.count])) };
  }

  diagnoseImprovements(now = new Date(), windowDays = 30, domains: string[] = []): { diagnosisId: string; metrics: Record<string, unknown>; findings: Array<Record<string, unknown>>; proposals: Array<Record<string, unknown>> } {
    const end = now.toISOString(); const start = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
    const run = this.database.prepare(`SELECT COUNT(*) runs,SUM(CASE WHEN status='partial' THEN 1 ELSE 0 END) partials,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failures FROM runs WHERE generated_at>=?`).get(start) as { runs: number; partials: number | null; failures: number | null };
    const receipt = this.database.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN result='failed' THEN 1 ELSE 0 END) failures,SUM(CASE WHEN result='updated' THEN 1 ELSE 0 END) updates FROM receipts WHERE COALESCE(attempted_at,'')>=?`).get(start) as { total: number; failures: number | null; updates: number | null };
    const corrections = this.database.prepare(`SELECT feedback_type,COUNT(*) count FROM feedback WHERE created_at>=? AND feedback_type IN ('classification-correction','score-correction','source-correction','process-feedback') GROUP BY feedback_type`).all(start) as Array<{ feedback_type: string; count: number }>;
    const feedback = this.database.prepare(`SELECT feedback_type,COUNT(*) count FROM feedback WHERE created_at>=? GROUP BY feedback_type`).all(start) as Array<{ feedback_type: string; count: number }>;
    const analyses = this.database.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failures,
      AVG(duration_ms) average_duration_ms,SUM(input_tokens) input_tokens,SUM(output_tokens) output_tokens,SUM(cost_usd) known_cost_usd,
      SUM(CASE WHEN status='success' AND cost_usd IS NULL THEN 1 ELSE 0 END) unknown_cost_observations FROM analysis_attempts WHERE attempted_at>=?`).get(start) as
      { total: number; failures: number | null; average_duration_ms: number | null; input_tokens: number | null; output_tokens: number | null; known_cost_usd: number | null; unknown_cost_observations: number | null };
    const duplicates = this.database.prepare(`SELECT COUNT(*) clusters FROM duplicate_clusters d JOIN runs r ON r.run_id=d.run_id WHERE r.generated_at>=?`).get(start) as { clusters: number };
    const sources = this.database.prepare(`SELECT source_id,COUNT(*) scans,SUM(CASE WHEN result='failed' THEN 1 ELSE 0 END) failures,SUM(CASE WHEN result='updated' THEN 1 ELSE 0 END) updates FROM receipts WHERE COALESCE(attempted_at,'')>=? GROUP BY source_id HAVING COUNT(*)>=5`).all(start) as Array<{ source_id: string; scans: number; failures: number; updates: number }>;
    const inWindow = (value: unknown) => typeof value === "string" && value >= start && value <= end;
    const remoteRuns = this.remoteControlRecords("runs").filter((record) => inWindow(record.payload.generated_at ?? record.payload.started_at));
    const remoteReceipts = this.remoteControlRecords("receipts").filter((record) => inWindow(record.payload.attempted_at ?? record.payload.completed_at));
    const remoteFeedback = this.remoteControlRecords("feedback").filter((record) => inWindow(record.payload.created_at));
    const feedbackCounts = new Map(feedback.map((row) => [row.feedback_type, row.count]));
    for (const record of remoteFeedback) {
      const type = String(record.payload.feedback_type ?? "reviewed"); feedbackCounts.set(type, (feedbackCounts.get(type) ?? 0) + 1);
    }
    const feedbackByType = Object.fromEntries(feedbackCounts);
    const coverageGaps = this.coverageGapDomains(domains, now, windowDays);
    const metrics = { windowDays, runs: run.runs, partialRuns: run.partials ?? 0, failedRuns: run.failures ?? 0, receipts: receipt.total, failedReceipts: receipt.failures ?? 0, updatedReceipts: receipt.updates ?? 0,
      analyses: analyses.total, failedAnalyses: analyses.failures ?? 0, duplicateClusters: duplicates.clusters, feedbackByType,
      modelPerformance: { averageDurationMs: analyses.average_duration_ms, inputTokens: analyses.input_tokens ?? 0, outputTokens: analyses.output_tokens ?? 0,
        knownCostUsd: analyses.known_cost_usd ?? 0, unknownCostObservations: analyses.unknown_cost_observations ?? 0 },
      coverageGaps,
      importedHistory: { runs: remoteRuns.length, receipts: remoteReceipts.length, feedback: remoteFeedback.length },
      corrections: Object.fromEntries(corrections.map((row) => [row.feedback_type, row.count])) };
    const findings: Array<Record<string, unknown>> = []; const proposals: Array<{ type: string; hypothesis: string; evidence: Record<string, unknown>; candidate: Record<string, unknown>; rollback: Record<string, unknown> }> = [];
    if (coverageGaps.length) {
      const finding = { type: "domain-coverage-gap", domains: coverageGaps, windowDays }; findings.push(finding);
      proposals.push({ type: "source-coverage", hypothesis: `Review source coverage for domains with no selected item in ${windowDays} days`, evidence: finding,
        candidate: { action: "review-source-set", domains: coverageGaps, automaticActivation: false }, rollback: { condition: "evidence quality or source reliability regresses", action: "restore previous source set and cadence" } });
    }
    const sourceMetrics = new Map(sources.map((source) => [source.source_id, { scans: source.scans, failures: source.failures, updates: source.updates }]));
    for (const record of remoteReceipts) {
      const sourceId = String(record.payload.source_id ?? record.links?.sources?.[0] ?? "UNKNOWN"); const current = sourceMetrics.get(sourceId) ?? { scans: 0, failures: 0, updates: 0 };
      current.scans += 1; if (record.payload.result === "failed") current.failures += 1; if (record.payload.result === "updated") current.updates += 1; sourceMetrics.set(sourceId, current);
    }
    for (const [sourceId, source] of sourceMetrics) if (source.scans >= 5 && source.failures / source.scans >= 0.3) {
      const finding = { type: "source-reliability", sourceId, scans: source.scans, failures: source.failures, failureRate: source.failures / source.scans }; findings.push(finding);
      proposals.push({ type: "source", hypothesis: `Review connector or reduce cadence for ${sourceId} because repeated failures exceed 30%`, evidence: finding, candidate: { sourceId, action: "human-review" }, rollback: { condition: "fetch success falls after an approved change", action: "restore previous source definition" } });
    }
    const correctionCount = ["classification-correction", "score-correction", "source-correction", "process-feedback"].reduce((sum, type) => sum + Number(feedbackByType[type] ?? 0), 0);
    if (correctionCount >= 5) {
      const finding = { type: "quality-corrections", correctionCount, byType: metrics.corrections }; findings.push(finding);
      proposals.push({ type: "policy-or-prompt", hypothesis: "Repeated human corrections warrant a frozen replay experiment", evidence: finding, candidate: { action: "create-experiment", automaticActivation: false }, rollback: { condition: "guardrail regression", action: "reject candidate" } });
    }
    const modelFailureRate = analyses.total ? (analyses.failures ?? 0) / analyses.total : 0;
    if ((analyses.failures ?? 0) >= 3 && modelFailureRate >= 0.1) {
      const finding = { type: "model-contract-reliability", attempts: analyses.total, failures: analyses.failures ?? 0, failureRate: modelFailureRate }; findings.push(finding);
      proposals.push({ type: "provider-or-prompt", hypothesis: "Repeated model contract failures warrant a shadow comparison of provider, model, or prompt pack", evidence: finding,
        candidate: { action: "shadow-run", preserveBaseline: true, automaticActivation: false }, rollback: { condition: "schema, evidence, latency, or cost guardrail regression", action: "reject candidate" } });
    }
    const negativeOutputSignals = Number(feedbackByType.ignored ?? 0) + Number(feedbackByType.skip ?? 0);
    if (negativeOutputSignals >= 5) {
      const finding = { type: "output-selection-dissatisfaction", ignored: Number(feedbackByType.ignored ?? 0), skipped: Number(feedbackByType.skip ?? 0) }; findings.push(finding);
      proposals.push({ type: "output-template-or-selection", hypothesis: "Repeated ignored or skipped selections warrant a frozen output and selection comparison", evidence: finding,
        candidate: { action: "shadow-render", automaticActivation: false }, rollback: { condition: "positive retention or evidence compliance regresses", action: "reject candidate" } });
    }
    if (duplicates.clusters >= 5) {
      const finding = { type: "duplicate-pressure", clusters: duplicates.clusters }; findings.push(finding);
      proposals.push({ type: "deduplication", hypothesis: "Repeated duplicate clusters warrant an offline normalization and deduplication replay", evidence: finding,
        candidate: { action: "frozen-replay", automaticActivation: false }, rollback: { condition: "distinct primary items merge", action: "reject candidate" } });
    }
    const diagnosisId = `DIA-${randomUUID()}`; const createdAt = end;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("INSERT INTO improvement_diagnoses(diagnosis_id,window_start,window_end,metrics_json,findings_json,created_at) VALUES(?,?,?,?,?,?)").run(diagnosisId, start, end, JSON.stringify(metrics), JSON.stringify(findings), createdAt);
      for (const proposal of proposals) this.database.prepare(`INSERT INTO improvement_proposals(proposal_id,diagnosis_id,proposal_type,status,hypothesis,evidence_json,candidate_json,rollback_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(`IMP-${randomUUID()}`, diagnosisId, proposal.type, "proposed", proposal.hypothesis, JSON.stringify(proposal.evidence), JSON.stringify(proposal.candidate), JSON.stringify(proposal.rollback), createdAt);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return { diagnosisId, metrics, findings, proposals };
  }

  diagnoseImprovementsIfDue(now = new Date(), windowDays = 30, minimumIntervalDays = 7, domains: string[] = []): { evaluated: boolean; reason: string; diagnosisId?: string; proposalCount: number } {
    const latest = this.database.prepare("SELECT created_at FROM improvement_diagnoses ORDER BY created_at DESC LIMIT 1").get() as { created_at: string } | undefined;
    if (latest && now.getTime() - new Date(latest.created_at).getTime() < minimumIntervalDays * 86_400_000) {
      return { evaluated: false, reason: `latest diagnosis is newer than ${minimumIntervalDays} days`, proposalCount: 0 };
    }
    const diagnosis = this.diagnoseImprovements(now, windowDays, domains);
    return { evaluated: true, reason: `evaluated a frozen ${windowDays}-day window without activating changes`, diagnosisId: diagnosis.diagnosisId, proposalCount: diagnosis.proposals.length };
  }

  improvementProposals(): Array<Record<string, unknown>> {
    return this.database.prepare("SELECT proposal_id,diagnosis_id,proposal_type,status,hypothesis,evidence_json,candidate_json,rollback_json,created_at,decided_at FROM improvement_proposals ORDER BY created_at DESC,proposal_id").all() as Array<Record<string, unknown>>;
  }

  createExperiment(policy: PolicyDefinition, baselinePolicy: PolicyDefinition, now = new Date().toISOString()): string {
    const id = `EXP-${randomUUID()}`;
    const baselineDigest = hashJson(baselinePolicy);
    const candidateDigest = hashJson(policy);
    this.database.prepare(`INSERT INTO experiments(
      experiment_id,status,baseline_policy_digest,baseline_policy_json,candidate_policy_json,candidate_policy_digest,created_at
    ) VALUES (?,?,?,?,?,?,?)`).run(id, "candidate", baselineDigest, JSON.stringify(baselinePolicy), JSON.stringify(policy), candidateDigest, now);
    return id;
  }

  experiment(id: string): { id: string; status: string; baselineDigest: string; baselinePolicy: PolicyDefinition; candidateDigest: string; policy: PolicyDefinition; sample: { itemIds: string[]; feedbackCutoff: string } | null; metrics: unknown } {
    const row = this.database.prepare(`SELECT status,baseline_policy_digest,baseline_policy_json,candidate_policy_json,
      candidate_policy_digest,sample_json,metrics_json FROM experiments WHERE experiment_id=?`).get(id) as {
        status: string; baseline_policy_digest: string; baseline_policy_json: string | null; candidate_policy_json: string;
        candidate_policy_digest: string | null; sample_json: string | null; metrics_json: string | null;
      } | undefined;
    if (!row) throw new Error(`Experiment not found: ${id}`);
    if (!row.baseline_policy_json) throw new Error(`Experiment ${id} predates frozen baseline policies and must be recreated`);
    const policy = JSON.parse(row.candidate_policy_json) as PolicyDefinition;
    return {
      id, status: row.status, baselineDigest: row.baseline_policy_digest,
      baselinePolicy: JSON.parse(row.baseline_policy_json) as PolicyDefinition,
      candidateDigest: row.candidate_policy_digest ?? hashJson(policy), policy,
      sample: row.sample_json ? JSON.parse(row.sample_json) as { itemIds: string[]; feedbackCutoff: string } : null,
      metrics: row.metrics_json ? JSON.parse(row.metrics_json) : null,
    };
  }

  evaluateExperiment(id: string, now = new Date()): { eligible: boolean; metrics: Record<string, unknown> } {
    const experiment = this.experiment(id);
    if (experiment.status !== "candidate" && experiment.status !== "evaluated") throw new Error(`Experiment ${id} cannot be evaluated from status ${experiment.status}`);
    const reviewed = this.database.prepare(`SELECT i.item_id,MIN(f.created_at) first_at,MAX(f.created_at) last_at
      FROM feedback f JOIN items i ON i.item_id=f.item_id GROUP BY i.item_id ORDER BY i.item_id`).all() as Array<{ item_id: string; first_at: string; last_at: string }>;
    const firstAt = reviewed.reduce<string | null>((value, row) => value === null || row.first_at < value ? row.first_at : value, null);
    const lastAt = reviewed.reduce<string | null>((value, row) => value === null || row.last_at > value ? row.last_at : value, null);
    const spanDays = firstAt && lastAt ? Math.floor((new Date(lastAt).getTime() - new Date(firstAt).getTime()) / 86_400_000) : 0;
    const eligible = experiment.sample !== null || (reviewed.length >= 50 && spanDays >= 14);
    const sample = experiment.sample ?? (eligible ? { itemIds: reviewed.map((row) => row.item_id), feedbackCutoff: now.toISOString() } : null);
    if (!eligible) {
      const metrics = { evaluatedAt: now.toISOString(), eligible: false, reviewedItems: reviewed.length, spanDays, minimumReviewedItems: 50, minimumSpanDays: 14 };
      this.database.prepare("UPDATE experiments SET metrics_json=? WHERE experiment_id=?").run(JSON.stringify(metrics), id);
      return { eligible: false, metrics };
    }
    const placeholders = sample!.itemIds.map(() => "?").join(",");
    const rows = this.database.prepare(`SELECT analysis_json FROM items WHERE item_id IN (${placeholders}) ORDER BY item_id`).all(...sample!.itemIds) as Array<{ analysis_json: string }>;
    if (rows.length !== sample!.itemIds.length) throw new Error(`Experiment ${id} frozen sample is incomplete`);
    const items = rows.map((row) => JSON.parse(row.analysis_json) as BriefingItem);
    const baseline = selectCandidatesUnderPolicy(experiment.baselinePolicy, items.map((item) => replayCandidateUnderPolicy(experiment.baselinePolicy, item)));
    const candidate = selectCandidatesUnderPolicy(experiment.policy, items.map((item) => replayCandidateUnderPolicy(experiment.policy, item)));
    const sampleDigest = createHash("sha256").update(`${sample!.itemIds.join("\n")}\n${sample!.feedbackCutoff}`).digest("hex");
    const frozenFeedback = this.database.prepare(`SELECT MIN(created_at) first_at,MAX(created_at) last_at FROM feedback
      WHERE item_id IN (${placeholders}) AND created_at<=?`).get(...sample!.itemIds, sample!.feedbackCutoff) as { first_at: string | null; last_at: string | null };
    const frozenSpanDays = frozenFeedback.first_at && frozenFeedback.last_at
      ? Math.floor((new Date(frozenFeedback.last_at).getTime() - new Date(frozenFeedback.first_at).getTime()) / 86_400_000) : 0;
    const feedbackRows = this.database.prepare(`SELECT feedback_type,COUNT(*) count FROM feedback
      WHERE item_id IN (${placeholders}) AND created_at<=? GROUP BY feedback_type`).all(...sample!.itemIds, sample!.feedbackCutoff) as Array<{ feedback_type: string; count: number }>;
    const feedbackDetails = this.database.prepare(`SELECT item_id,feedback_type FROM feedback
      WHERE item_id IN (${placeholders}) AND created_at<=? ORDER BY item_id,feedback_type`).all(...sample!.itemIds, sample!.feedbackCutoff) as Array<{ item_id: string; feedback_type: string }>;
    const selectedIds = (selection: typeof baseline) => new Set([...selection.daily, ...selection.review].map((item) => item.id));
    const baselineSelected = selectedIds(baseline); const candidateSelected = selectedIds(candidate);
    const positiveIds = new Set(feedbackDetails.filter((row) => ["used", "knowledge-worthy", "include"].includes(row.feedback_type)).map((row) => row.item_id));
    const negativeIds = new Set(feedbackDetails.filter((row) => ["ignored", "skip", "classification-correction", "score-correction", "source-correction"].includes(row.feedback_type)).map((row) => row.item_id));
    const utility = (selected: Set<string>) => ({ positiveRetained: [...positiveIds].filter((id) => selected.has(id)).length, negativeSelected: [...negativeIds].filter((id) => selected.has(id)).length });
    const baselineUtility = utility(baselineSelected); const candidateUtility = utility(candidateSelected);
    const baselineEvidence = [...baseline.daily, ...baseline.review].filter((item) => item.evidenceStatus === "confirmed-primary").length;
    const candidateEvidence = [...candidate.daily, ...candidate.review].filter((item) => item.evidenceStatus === "confirmed-primary").length;
    const guardrailsPassed = candidateUtility.positiveRetained >= baselineUtility.positiveRetained && candidateUtility.negativeSelected <= baselineUtility.negativeSelected && candidateEvidence >= baselineEvidence;
    const strictImprovement = candidateUtility.positiveRetained > baselineUtility.positiveRetained || candidateUtility.negativeSelected < baselineUtility.negativeSelected;
    const metrics = {
      evaluatedAt: now.toISOString(), eligible: true, reviewedItems: sample!.itemIds.length, spanDays: frozenSpanDays,
      sampleDigest, baselinePolicyDigest: experiment.baselineDigest, candidatePolicyDigest: experiment.candidateDigest,
      baseline: { daily: baseline.daily.length, review: baseline.review.length, machineOnly: baseline.machineOnly.length },
      candidate: { daily: candidate.daily.length, review: candidate.review.length, machineOnly: candidate.machineOnly.length },
      delta: { daily: candidate.daily.length - baseline.daily.length, review: candidate.review.length - baseline.review.length, machineOnly: candidate.machineOnly.length - baseline.machineOnly.length },
      feedbackByType: Object.fromEntries(feedbackRows.map((row) => [row.feedback_type, row.count])),
      utility: { baseline: baselineUtility, candidate: candidateUtility, labeledPositive: positiveIds.size, labeledNegative: negativeIds.size },
      guardrails: { baselineConfirmedPrimary: baselineEvidence, candidateConfirmedPrimary: candidateEvidence, passed: guardrailsPassed },
      recommendation: guardrailsPassed && strictImprovement ? "approve" : "reject",
    };
    this.database.prepare("UPDATE experiments SET status='evaluated',sample_json=?,sample_digest=?,metrics_json=? WHERE experiment_id=?")
      .run(JSON.stringify(sample), sampleDigest, JSON.stringify(metrics), id);
    return { eligible, metrics };
  }

  transitionExperiment(id: string, action: "approve" | "activate" | "rollback", now = new Date().toISOString()): { status: string; policy: PolicyDefinition } {
    const current = this.experiment(id);
    const allowed: Record<typeof action, string[]> = { approve: ["evaluated"], activate: ["approved"], rollback: ["active"] };
    if (!allowed[action].includes(current.status)) throw new Error(`Experiment ${id} cannot ${action} from status ${current.status}`);
    if (action === "approve") {
      const metrics = current.metrics as { recommendation?: string; guardrails?: { passed?: boolean } } | null;
      if (metrics?.recommendation !== "approve" || metrics.guardrails?.passed !== true) throw new Error(`Experiment ${id} cannot approve: evaluation did not demonstrate a guarded improvement`);
    }
    if (action === "activate") {
      const other = this.database.prepare("SELECT experiment_id FROM experiments WHERE status='active' AND experiment_id<>?").get(id) as { experiment_id: string } | undefined;
      if (other) throw new Error(`Experiment ${other.experiment_id} is already active; roll it back before activating another`);
    }
    const status = action === "approve" ? "approved" : action === "activate" ? "active" : "rolled-back";
    const column = action === "approve" ? "approved_at" : action === "activate" ? "activated_at" : "rolled_back_at";
    this.database.prepare(`UPDATE experiments SET status=?,${column}=? WHERE experiment_id=?`).run(status, now, id);
    return { status, policy: current.policy };
  }

  createKnowledgeProposal(itemId: string, targetPath: string, targetHeading: string | undefined, expectedTargetHash: string | undefined, content: string, now = new Date().toISOString(), proposalId = `KNP-${randomUUID()}`): string {
    const item = this.database.prepare("SELECT 1 FROM items WHERE item_id=?").get(itemId);
    if (!item) throw new Error(`Item not found: ${itemId}`);
    this.database.prepare(`INSERT INTO knowledge_proposals(proposal_id,item_id,status,target_path,target_heading,expected_target_hash,content,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(proposalId, itemId, "proposed", targetPath, targetHeading ?? null, expectedTargetHash ?? null, content, now);
    return proposalId;
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

  latestLivePreview(configDigestValue: string): { runId: string; generatedAt: string; status: string; path: string; contentHash: string } | null {
    const row = this.database.prepare(`SELECT r.run_id,r.generated_at,r.status,a.path,a.content_hash
      FROM runs r JOIN output_artifacts a ON a.run_id=r.run_id AND a.kind='preview-markdown'
      WHERE r.run_kind='preview' AND r.mode='live' AND r.config_digest=? AND r.status IN ('success','partial')
      ORDER BY r.generated_at DESC LIMIT 1`).get(configDigestValue) as {
        run_id: string; generated_at: string; status: string; path: string; content_hash: string;
      } | undefined;
    return row ? { runId: row.run_id, generatedAt: row.generated_at, status: row.status, path: row.path, contentHash: row.content_hash } : null;
  }

  disableSchedule(id: string, now = new Date().toISOString()): void {
    this.database.prepare("UPDATE schedule_installations SET disabled_at=? WHERE schedule_id=? AND disabled_at IS NULL").run(now, id);
  }

  sourceCadenceMetrics(sourceId: string, since: string): { successes: number; failures: number; updates: number; selections: number; firstReceiptAt: string | null; currentHours: number | null; humanLocked: boolean } {
    const receipts = this.database.prepare(`SELECT
      SUM(CASE WHEN result IN ('updated','unchanged','observed') THEN 1 ELSE 0 END) successes,
      SUM(CASE WHEN result='failed' THEN 1 ELSE 0 END) failures,SUM(CASE WHEN result='updated' THEN 1 ELSE 0 END) updates
      FROM receipts WHERE source_id=? AND COALESCE(attempted_at,'')>=?`).get(sourceId, since) as { successes: number | null; failures: number | null; updates: number | null };
    const lifetime = this.database.prepare("SELECT MIN(attempted_at) first_at FROM receipts WHERE source_id=? AND attempted_at IS NOT NULL").get(sourceId) as { first_at: string | null };
    const selected = this.database.prepare(`SELECT COUNT(*) count FROM items i JOIN runs r ON r.run_id=i.run_id
      WHERE i.capture_id IN (SELECT capture_id FROM captures WHERE source_id=?) AND i.disposition IN ('daily','review') AND r.generated_at>=?`).get(sourceId, since) as { count: number };
    const settings = this.database.prepare("SELECT cadence_hours,human_locked FROM source_settings WHERE source_id=?").get(sourceId) as { cadence_hours: number; human_locked: number } | undefined;
    return { successes: receipts.successes ?? 0, failures: receipts.failures ?? 0, updates: receipts.updates ?? 0, selections: selected.count, firstReceiptAt: lifetime.first_at, currentHours: settings?.cadence_hours ?? null, humanLocked: settings?.human_locked === 1 };
  }

  cadenceOverrides(sources: EffectiveConfig["preset"]["sources"]): Array<{ sourceId: string; hours: number; humanLocked: boolean; updatedAt: string }> {
    const defaults = new Map(sources.map((source) => [source.id, source.cadence?.defaultHours ?? 24]));
    return (this.database.prepare("SELECT source_id,cadence_hours,human_locked,updated_at FROM source_settings ORDER BY source_id").all() as Array<{ source_id: string; cadence_hours: number; human_locked: number; updated_at: string }>)
      .filter((row) => row.cadence_hours !== defaults.get(row.source_id) || row.human_locked === 1)
      .map((row) => ({ sourceId: row.source_id, hours: row.cadence_hours, humanLocked: row.human_locked === 1, updatedAt: row.updated_at }));
  }

  recordCadenceRecommendation(sourceId: string, direction: "up" | "down" | "none", now: string): number {
    if (direction === "none") { this.database.prepare("DELETE FROM cadence_recommendation_streaks WHERE source_id=?").run(sourceId); return 0; }
    const current = this.database.prepare("SELECT direction,consecutive_cycles,last_evaluated_at FROM cadence_recommendation_streaks WHERE source_id=?").get(sourceId) as { direction: string; consecutive_cycles: number; last_evaluated_at: string } | undefined;
    if (current && current.last_evaluated_at.slice(0, 10) === now.slice(0, 10)) return current.consecutive_cycles;
    const consecutive = current?.direction === direction ? current.consecutive_cycles + 1 : 1;
    this.database.prepare(`INSERT INTO cadence_recommendation_streaks(source_id,direction,consecutive_cycles,last_evaluated_at) VALUES(?,?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET direction=excluded.direction,consecutive_cycles=excluded.consecutive_cycles,last_evaluated_at=excluded.last_evaluated_at`).run(sourceId, direction, consecutive, now);
    return consecutive;
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
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (decision === "approve") this.database.prepare(`INSERT INTO source_settings(source_id,cadence_hours,human_locked,updated_at) VALUES (?,?,0,?)
        ON CONFLICT(source_id) DO UPDATE SET cadence_hours=excluded.cadence_hours,updated_at=excluded.updated_at`).run(row.source_id, row.proposed_hours, now);
      this.database.prepare("UPDATE cadence_proposals SET status=?,decided_at=? WHERE proposal_id=?").run(decision === "approve" ? "approved" : "rejected", now, id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
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
    const outcome = runOutcome(countReceipts(result.dueSourceIds ?? config.preset.sources.map((source) => source.id), result.receipts));
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

function captureIdentity(capture: CaptureEnvelope): string {
  const day = capture.capturedAt.slice(0, 10).replace(/-/g, "");
  return `CAP-${day}-${createHash("sha256").update(`${capture.sourceId}\n${capture.canonicalUrl}\n${capture.externalKey}\n${capture.contentHash}`).digest("hex").slice(0, 16).toUpperCase()}`;
}
