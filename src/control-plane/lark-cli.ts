import { spawnSync } from "node:child_process";

export type LarkRunner = (args: string[]) => unknown;

function readOnlyCommand(args: string[]): boolean {
  if (args.length === 1 && (args[0] === "--version" || args[0] === "whoami")) return true;
  return args[0] === "base" && ["+table-list", "+field-list", "+record-list", "+record-get", "+data-query"].includes(args[1] ?? "");
}

function transientReadFailure(error: Error): boolean {
  return /(?:network|timeout|timed out|TLS handshake|connection reset|ECONNRESET|temporarily unavailable|unexpected EOF)/i.test(error.message);
}

function wait(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function systemLarkRunner(profile?: string, options: { timeoutMs?: number; readRetries?: number; retryDelayMs?: number } = {}): LarkRunner {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const readRetries = options.readRetries ?? 4;
  const retryDelayMs = options.retryDelayMs ?? 250;
  return (args) => {
    const command = [...args, ...(profile ? ["--profile", profile] : [])];
    for (let attempt = 0; ; attempt += 1) {
      const result = spawnSync("lark-cli", command, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, killSignal: "SIGKILL" });
      let failure: Error | undefined;
      if (result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT") failure = new Error(`lark-cli timed out after ${timeoutMs} ms`);
      else if (result.error) failure = result.error;
      else if (result.status !== 0) failure = new Error(result.stderr || result.stdout || `lark-cli exited ${result.status}`);
      if (failure) {
        if (readOnlyCommand(args) && transientReadFailure(failure) && attempt < readRetries) {
          wait(retryDelayMs * (attempt + 1));
          continue;
        }
        throw failure;
      }
      if (args.length === 1 && args[0] === "--version") return result.stdout.trim();
      let parsed: unknown;
      try { parsed = JSON.parse(result.stdout); }
      catch { throw new Error("lark-cli returned non-JSON output"); }
      const envelope = parsed as { ok?: boolean; data?: unknown; error?: { message?: string; hint?: string } };
      if (envelope.ok === false) {
        failure = new Error([envelope.error?.message, envelope.error?.hint].filter(Boolean).join(": ") || "lark-cli request failed");
        if (readOnlyCommand(args) && transientReadFailure(failure) && attempt < readRetries) {
          wait(retryDelayMs * (attempt + 1));
          continue;
        }
        throw failure;
      }
      return envelope.ok === true ? envelope.data : parsed;
    }
  };
}

export interface LarkRecordPage {
  record_id_list: string[];
  fields: string[];
  data: unknown[][];
  has_more: boolean;
}

export interface LarkTableSummary { id: string; name: string }
export interface LarkFieldOption {
  name: string;
  hue?: string;
  lightness?: string;
}
export interface LarkFieldDefinition {
  name: string;
  type: "text" | "number" | "datetime" | "select" | "link";
  multiple?: boolean;
  options?: LarkFieldOption[];
  link_table?: string;
  bidirectional?: boolean;
  bidirectional_link_field_name?: string;
}

function assertNoIgnoredFields(operation: string, response: unknown): void {
  if (!response || typeof response !== "object") return;
  const value = response as Record<string, unknown>;
  const ignored = value.ignored_fields ?? value.ignoredFields;
  const count = Array.isArray(ignored) ? ignored.length
    : ignored && typeof ignored === "object" ? Object.keys(ignored as Record<string, unknown>).length
      : ignored ? 1 : 0;
  if (count) throw new Error(`${operation} ignored ${count} field value${count === 1 ? "" : "s"}`);
}

export class LarkCliClient {
  constructor(
    readonly baseToken: string,
    readonly identity: "user" | "bot",
    private readonly runner: LarkRunner,
  ) {}

  whoami(): unknown { return this.runner(["whoami"]); }
  version(): string { return String(this.runner(["--version"])); }

  tables(): LarkTableSummary[] {
    const data = this.runner(["base", "+table-list", "--base-token", this.baseToken, "--as", this.identity, "--json"]);
    return (data as { tables?: LarkTableSummary[] }).tables ?? [];
  }

  createTable(name: string, fields: LarkFieldDefinition[]): string {
    const data = this.runner(["base", "+table-create", "--base-token", this.baseToken, "--name", name,
      "--fields", JSON.stringify(fields), "--as", this.identity, "--json"]);
    const value = data && typeof data === "object" ? data as Record<string, unknown> : {};
    const nested = value.table && typeof value.table === "object" ? value.table as Record<string, unknown> : {};
    const id = value.table_id ?? value.tableId ?? nested.table_id ?? nested.tableId ?? nested.id ?? value.id;
    if (typeof id !== "string" || !id) throw new Error(`lark-cli did not return a table ID for ${name}`);
    return id;
  }

  createField(tableId: string, field: LarkFieldDefinition): void {
    this.runner(["base", "+field-create", "--base-token", this.baseToken, "--table-id", tableId,
      "--json", JSON.stringify(field), "--as", this.identity, "--format", "json"]);
  }

  updateField(tableId: string, fieldId: string, field: LarkFieldDefinition): void {
    this.runner(["base", "+field-update", "--base-token", this.baseToken, "--table-id", tableId, "--field-id", fieldId,
      "--json", JSON.stringify(field), "--yes", "--as", this.identity, "--format", "json"]);
  }

  fields(tableId: string): Array<LarkFieldDefinition & { id: string }> {
    const data = this.runner(["base", "+field-list", "--base-token", this.baseToken, "--table-id", tableId, "--as", this.identity, "--json"]);
    return (data as { fields?: Array<LarkFieldDefinition & { id: string }> }).fields ?? [];
  }

  records(tableId: string, fields: string[]): Array<{ recordId: string; fields: Record<string, unknown> }> {
    const rows: Array<{ recordId: string; fields: Record<string, unknown> }> = [];
    for (let offset = 0; ; offset += 200) {
      const args = ["base", "+record-list", "--base-token", this.baseToken, "--table-id", tableId];
      for (const field of fields) args.push("--field-id", field);
      args.push("--offset", String(offset), "--limit", "200", "--json", "--as", this.identity);
      const page = this.runner(args) as LarkRecordPage;
      for (let row = 0; row < page.record_id_list.length; row += 1) {
        const values: Record<string, unknown> = {};
        page.fields.forEach((field, column) => { values[field] = page.data[row]?.[column]; });
        rows.push({ recordId: page.record_id_list[row]!, fields: values });
      }
      if (!page.has_more) return rows;
    }
  }

  recordsMatchingAny(tableId: string, idField: string, values: string[], fields: string[]): Array<{ recordId: string; fields: Record<string, unknown> }> {
    if (!values.length) return [];
    const rows = new Map<string, { recordId: string; fields: Record<string, unknown> }>();
    for (let start = 0; start < values.length; start += 40) {
      const batch = values.slice(start, start + 40);
      const filter = JSON.stringify({ logic: "or", conditions: batch.map((value) => [idField, "==", value]) });
      for (let offset = 0; ; offset += 200) {
        const args = ["base", "+record-list", "--base-token", this.baseToken, "--table-id", tableId];
        for (const field of [...new Set([idField, ...fields])]) args.push("--field-id", field);
        args.push("--filter-json", filter, "--offset", String(offset), "--limit", "200", "--json", "--as", this.identity);
        const page = this.runner(args) as LarkRecordPage;
        for (let row = 0; row < page.record_id_list.length; row += 1) {
          const projected: Record<string, unknown> = {};
          page.fields.forEach((field, column) => { projected[field] = page.data[row]?.[column]; });
          const recordId = page.record_id_list[row]!;
          rows.set(recordId, { recordId, fields: projected });
        }
        if (!page.has_more) break;
      }
    }
    const expected = new Set(values);
    return [...rows.values()].filter((row) => expected.has(String(row.fields[idField] ?? "")));
  }

  recordsByIds(tableId: string, recordIds: string[], fields: string[]): Array<{ recordId: string; fields: Record<string, unknown> }> {
    if (!recordIds.length) return [];
    try {
      const rows: Array<{ recordId: string; fields: Record<string, unknown> }> = [];
      for (let start = 0; start < recordIds.length; start += 100) {
        const batch = recordIds.slice(start, start + 100);
        const args = ["base", "+record-get", "--base-token", this.baseToken, "--table-id", tableId];
        for (const recordId of batch) args.push("--record-id", recordId);
        for (const field of fields) args.push("--field-id", field);
        args.push("--format", "json", "--as", this.identity);
        const page = this.runner(args) as LarkRecordPage;
        for (let row = 0; row < page.record_id_list.length; row += 1) {
          const projected: Record<string, unknown> = {};
          page.fields.forEach((field, column) => { projected[field] = page.data[row]?.[column]; });
          rows.push({ recordId: page.record_id_list[row]!, fields: projected });
        }
      }
      return rows;
    } catch {
      const expected = new Set(recordIds);
      return this.records(tableId, fields).filter((row) => expected.has(row.recordId));
    }
  }

  countRecords(tableId: string, idField: string): number {
    const dsl = JSON.stringify({ datasource: { type: "table", table: { tableId } }, measures: [{ field_name: idField, aggregation: "count", alias: "count" }], shaper: { format: "flat" } });
    const data = this.runner(["base", "+data-query", "--base-token", this.baseToken, "--dsl", dsl, "--as", this.identity, "--json"]);
    const value = data && typeof data === "object" ? data as Record<string, unknown> : {};
    const rows = Array.isArray(value.main_data) ? value.main_data : [];
    const first = rows[0] && typeof rows[0] === "object" ? rows[0] as Record<string, unknown> : {};
    const count = first.count && typeof first.count === "object" ? (first.count as Record<string, unknown>).value : first.count;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error(`lark-cli did not return a valid record count for ${tableId}`);
    return count;
  }

  upsert(tableId: string, fields: Record<string, unknown>, recordId?: string, dryRun = false): unknown {
    return this.runner(["base", "+record-upsert", "--base-token", this.baseToken, "--table-id", tableId,
      "--json", JSON.stringify(fields), ...(recordId ? ["--record-id", recordId] : []), ...(dryRun ? ["--dry-run"] : []), "--as", this.identity]);
  }

  batchUpdate(tableId: string, records: Record<string, Record<string, unknown>>): unknown {
    const response = this.runner(["base", "+record-batch-update", "--base-token", this.baseToken, "--table-id", tableId,
      "--json", JSON.stringify({ update_records: records }), "--as", this.identity]);
    assertNoIgnoredFields("record batch update", response);
    return response;
  }

  batchCreate(tableId: string, records: Array<Record<string, unknown>>): unknown {
    const response = this.runner(["base", "+record-batch-create", "--base-token", this.baseToken, "--table-id", tableId,
      "--json", JSON.stringify({ create_records: records }), "--as", this.identity]);
    assertNoIgnoredFields("record batch create", response);
    return response;
  }
}
