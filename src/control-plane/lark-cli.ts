import { spawnSync } from "node:child_process";

export type LarkRunner = (args: string[]) => unknown;

export function systemLarkRunner(profile?: string): LarkRunner {
  return (args) => {
    const command = [...args, ...(profile ? ["--profile", profile] : [])];
    const result = spawnSync("lark-cli", command, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `lark-cli exited ${result.status}`);
    if (args.length === 1 && args[0] === "--version") return result.stdout.trim();
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); }
    catch { throw new Error("lark-cli returned non-JSON output"); }
    const envelope = parsed as { ok?: boolean; data?: unknown; error?: { message?: string; hint?: string } };
    if (envelope.ok === false) throw new Error([envelope.error?.message, envelope.error?.hint].filter(Boolean).join(": ") || "lark-cli request failed");
    return envelope.ok === true ? envelope.data : parsed;
  };
}

export interface LarkRecordPage {
  record_id_list: string[];
  fields: string[];
  data: unknown[][];
  has_more: boolean;
}

export interface LarkTableSummary { id: string; name: string }
export interface LarkFieldDefinition {
  name: string;
  type: "text" | "number" | "datetime" | "select" | "link";
  multiple?: boolean;
  linkTableId?: string;
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

  fields(tableId: string): Array<{ id: string; name: string; type: string; link_table?: string }> {
    const data = this.runner(["base", "+field-list", "--base-token", this.baseToken, "--table-id", tableId, "--as", this.identity, "--json"]);
    return (data as { fields?: Array<{ id: string; name: string; type: string; link_table?: string }> }).fields ?? [];
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

  upsert(tableId: string, fields: Record<string, unknown>, recordId?: string, dryRun = false): unknown {
    return this.runner(["base", "+record-upsert", "--base-token", this.baseToken, "--table-id", tableId,
      "--json", JSON.stringify(fields), ...(recordId ? ["--record-id", recordId] : []), ...(dryRun ? ["--dry-run"] : []), "--as", this.identity]);
  }
}
