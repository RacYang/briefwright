import { createHash } from "node:crypto";

import mysql, { type Pool as MysqlPool } from "mysql2/promise";
import pg from "pg";

import type { EffectiveConfig, RuleSnapshot, SourceDefinition } from "../config/types.js";
import { canonicalJson } from "../config/load.js";
import { resolveSecret } from "../config/secrets.js";
import type { CanonicalControlRecord, ControlEntityKind, ControlPlaneCheck, ControlPlaneSnapshot, ControlPlaneStore, SyncPlan, SyncResult } from "./types.js";

const KINDS = new Set<ControlEntityKind>(["sources", "runs", "items", "events", "feedback", "experiments", "captures", "rules", "receipts"]);
interface SqlRow { kind: string; business_id: string; payload_json: unknown; links_json: unknown; updated_at: Date | string; }

function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function parsed(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}
function recordsFromRows(rows: SqlRow[]): CanonicalControlRecord[] {
  return rows.flatMap((row) => {
    if (!KINDS.has(row.kind as ControlEntityKind)) return [];
    const links = parsed(row.links_json) as NonNullable<CanonicalControlRecord["links"]>;
    return [{ kind: row.kind as ControlEntityKind, id: row.business_id, payload: parsed(row.payload_json),
      ...(Object.keys(links).length ? { links } : {}), updatedAt: new Date(row.updated_at).toISOString() }];
  });
}
function snapshot(records: CanonicalControlRecord[]): ControlPlaneSnapshot {
  const sources = records.filter((record) => record.kind === "sources").map((record) => record.payload as unknown as SourceDefinition);
  const rules = records.filter((record) => record.kind === "rules").map((record) => record.payload as unknown as RuleSnapshot);
  return { revision: digest(records), sources, rules, feedback: records.filter((record) => record.kind === "feedback"), records };
}

abstract class SqlControlPlane implements ControlPlaneStore {
  abstract readonly driver: "postgres" | "mysql";
  protected connectionValue?: string;
  constructor(protected readonly config: EffectiveConfig) {}
  protected async connection(): Promise<string> {
    if (!this.config.controlPlane.connection) throw new Error(`${this.driver} requires a connection secret reference`);
    return this.connectionValue ??= await resolveSecret(this.config.controlPlane.connection, this.config.projectRoot);
  }
  abstract ensureSchema(): Promise<void>;
  protected abstract verifySchema(): Promise<void>;
  protected abstract rows(): Promise<SqlRow[]>;
  protected abstract write(records: CanonicalControlRecord[]): Promise<void>;
  abstract close(): Promise<void>;
  async doctor(): Promise<ControlPlaneCheck[]> {
    try { await this.verifySchema(); const rows = await this.rows(); return [{ name: `control-plane:${this.driver}`, ok: true, detail: `connected read-only; schema current; ${rows.length} canonical records` }]; }
    catch (error) { return [{ name: `control-plane:${this.driver}`, ok: false, detail: `${error instanceof Error ? error.message : String(error)}. Run 'briefwright sql provision --yes' if this is a new database.` }]; }
  }
  async pull(_mode: "context" | "full" = "context"): Promise<ControlPlaneSnapshot> { await this.verifySchema(); return snapshot(recordsFromRows(await this.rows())); }
  async plan(records: CanonicalControlRecord[]): Promise<SyncPlan> {
    await this.verifySchema();
    const current = new Map(recordsFromRows(await this.rows()).map((record) => [`${record.kind}:${record.id}`, record]));
    const creates: CanonicalControlRecord[] = []; const updates: CanonicalControlRecord[] = []; const unchanged: CanonicalControlRecord[] = [];
    for (const record of records) {
      const existing = current.get(`${record.kind}:${record.id}`);
      if (!existing) creates.push(record);
      else if (digest({ payload: existing.payload, links: existing.links ?? {} }) === digest({ payload: record.payload, links: record.links ?? {} })) unchanged.push(record);
      else updates.push(record);
    }
    return { driver: this.driver, creates, updates, unchanged, conflicts: [], digest: digest(records) };
  }
  async apply(plan: SyncPlan): Promise<SyncResult> {
    if (plan.driver !== this.driver) throw new Error(`Cannot apply ${plan.driver} plan through ${this.driver}`);
    if (plan.conflicts.length) throw new Error("Cannot apply a sync plan with unresolved conflicts");
    const records = [...plan.creates, ...plan.updates];
    try { await this.ensureSchema(); await this.write(records); return { driver: this.driver, created: plan.creates.length, updated: plan.updates.length, unchanged: plan.unchanged.length, failed: [], digest: plan.digest, acknowledged: true, readbackRevision: "transaction-committed", readbackDigest: plan.digest }; }
    catch (error) { const detail = error instanceof Error ? error.message : String(error); return { driver: this.driver, created: 0, updated: 0, unchanged: plan.unchanged.length, failed: records.map((record) => ({ kind: record.kind, id: record.id, detail })), digest: plan.digest, acknowledged: false }; }
  }
}

export class PostgresControlPlane extends SqlControlPlane {
  readonly driver = "postgres" as const;
  private pool?: pg.Pool;
  private async client(): Promise<pg.Pool> { return this.pool ??= new pg.Pool({ connectionString: await this.connection(), max: 4 }); }
  async ensureSchema(): Promise<void> { await (await this.client()).query(`CREATE TABLE IF NOT EXISTS briefwright_records (
    kind VARCHAR(32) NOT NULL, business_id VARCHAR(255) NOT NULL, payload_json JSONB NOT NULL,
    links_json JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (kind,business_id))`); await (await this.client()).query("CREATE TABLE IF NOT EXISTS briefwright_meta (schema_version INTEGER NOT NULL)");
    await (await this.client()).query("INSERT INTO briefwright_meta(schema_version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM briefwright_meta)");
    const versions = (await (await this.client()).query<{ schema_version: number }>("SELECT DISTINCT schema_version FROM briefwright_meta ORDER BY schema_version")).rows.map((row) => row.schema_version);
    if (versions.length !== 1 || versions[0] !== 1) throw new Error(`Unsupported PostgreSQL control-plane schema version(s): ${versions.join(", ") || "none"}`);
  }
  protected async verifySchema(): Promise<void> {
    const versions = (await (await this.client()).query<{ schema_version: number }>("SELECT DISTINCT schema_version FROM briefwright_meta ORDER BY schema_version")).rows.map((row) => row.schema_version);
    if (versions.length !== 1 || versions[0] !== 1) throw new Error(`Unsupported PostgreSQL control-plane schema version(s): ${versions.join(", ") || "none"}`);
    await (await this.client()).query("SELECT kind,business_id,payload_json,links_json,updated_at FROM briefwright_records LIMIT 0");
  }
  protected async rows(): Promise<SqlRow[]> { return (await (await this.client()).query<SqlRow>("SELECT kind,business_id,payload_json,links_json,updated_at FROM briefwright_records ORDER BY kind,business_id")).rows; }
  protected async write(records: CanonicalControlRecord[]): Promise<void> {
    if (!records.length) return; const client = await (await this.client()).connect();
    try { await client.query("BEGIN"); for (const record of records) await client.query(`INSERT INTO briefwright_records(kind,business_id,payload_json,links_json,updated_at)
      VALUES($1,$2,$3::jsonb,$4::jsonb,CURRENT_TIMESTAMP) ON CONFLICT(kind,business_id) DO UPDATE
      SET payload_json=EXCLUDED.payload_json,links_json=EXCLUDED.links_json,updated_at=CURRENT_TIMESTAMP`,
    [record.kind, record.id, JSON.stringify(record.payload), JSON.stringify(record.links ?? {})]); await client.query("COMMIT"); }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async close(): Promise<void> { if (this.pool) await this.pool.end(); }
}

export class MysqlControlPlane extends SqlControlPlane {
  readonly driver = "mysql" as const;
  private pool?: MysqlPool;
  private async client(): Promise<MysqlPool> { return this.pool ??= mysql.createPool({ uri: await this.connection(), connectionLimit: 4, timezone: "Z" }); }
  async ensureSchema(): Promise<void> { await (await this.client()).execute(`CREATE TABLE IF NOT EXISTS briefwright_records (
    kind VARCHAR(32) NOT NULL, business_id VARCHAR(255) NOT NULL, payload_json JSON NOT NULL,
    links_json JSON NOT NULL, updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (kind,business_id)) ENGINE=InnoDB`); await (await this.client()).execute("CREATE TABLE IF NOT EXISTS briefwright_meta (schema_version INT NOT NULL)");
    await (await this.client()).execute("INSERT INTO briefwright_meta(schema_version) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM briefwright_meta)");
    const [rows] = await (await this.client()).query("SELECT DISTINCT schema_version FROM briefwright_meta ORDER BY schema_version");
    const versions = (rows as Array<{ schema_version: number }>).map((row) => Number(row.schema_version));
    if (versions.length !== 1 || versions[0] !== 1) throw new Error(`Unsupported MySQL control-plane schema version(s): ${versions.join(", ") || "none"}`);
  }
  protected async verifySchema(): Promise<void> {
    const [rows] = await (await this.client()).query("SELECT DISTINCT schema_version FROM briefwright_meta ORDER BY schema_version");
    const versions = (rows as Array<{ schema_version: number }>).map((row) => Number(row.schema_version));
    if (versions.length !== 1 || versions[0] !== 1) throw new Error(`Unsupported MySQL control-plane schema version(s): ${versions.join(", ") || "none"}`);
    await (await this.client()).query("SELECT kind,business_id,payload_json,links_json,updated_at FROM briefwright_records LIMIT 0");
  }
  protected async rows(): Promise<SqlRow[]> { const [rows] = await (await this.client()).query("SELECT kind,business_id,payload_json,links_json,updated_at FROM briefwright_records ORDER BY kind,business_id"); return rows as SqlRow[]; }
  protected async write(records: CanonicalControlRecord[]): Promise<void> {
    if (!records.length) return; const connection = await (await this.client()).getConnection();
    try { await connection.beginTransaction(); for (const record of records) await connection.execute(`INSERT INTO briefwright_records(kind,business_id,payload_json,links_json,updated_at)
      VALUES(?,?,?,?,CURRENT_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE payload_json=VALUES(payload_json),links_json=VALUES(links_json),updated_at=CURRENT_TIMESTAMP(3)`,
    [record.kind, record.id, JSON.stringify(record.payload), JSON.stringify(record.links ?? {})]); await connection.commit(); }
    catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async close(): Promise<void> { if (this.pool) await this.pool.end(); }
}
