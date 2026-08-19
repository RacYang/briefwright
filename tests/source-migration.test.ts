import { describe, expect, it } from "vitest";

import { assertSourceMigrationAuthorization, assertSourceMigrationPostApplyClean, parseSourceMigration, sourceMigrationRecords } from "../src/commands/source-migration.js";
import type { EffectiveConfig, SourceDefinition } from "../src/config/types.js";
import type { ControlPlaneSnapshot } from "../src/control-plane/types.js";

const source: SourceDefinition = { id: "SRC-ONE", title: "One", enabled: true, priority: 91, coverageDomains: ["模型"],
  scheduleState: { frequency: "daily", humanLocked: true }, cadence: { minimumHours: 1, defaultHours: 24, maximumHours: 72 },
  connector: { type: "webpage", config: { url: "https://example.com/news" } } };

function config(): EffectiveConfig {
  return { configVersion: 3, projectRoot: "/tmp/project", name: "test", preset: { id: "test", version: "1", title: "test", description: "test", quality: "strict", coverage: "focused", cost: "low", sources: [source] },
    interests: ["模型"], schedule: "manual", output: { format: "markdown", directory: "out" }, storage: { driver: "sqlite", path: "/tmp/state.db" },
    controlPlane: { driver: "lark", mode: "configured", lark: { baseToken: "base", identity: "user", tables: { sources: "a", runs: "b", items: "c", events: "d", feedback: "e", experiments: "f", captures: "g", rules: "h", receipts: "i" }, xCapture: "codex-browser" } },
    documents: { driver: "local", mode: "configured", root: "/tmp/project", briefingDirectory: "out" }, runtime: { httpConcurrency: 1, modelConcurrency: 1, maximumCapturesPerRun: 1, retries: 0, timeoutSeconds: 30 },
    policy: { id: "p", version: "1", rules: [], score: { dimensions: [], dailyThreshold: 1, reviewMinimum: 1, dailyMaximum: 1, perDomainMaximum: 1 }, domains: ["模型"], retention: { quoteWordLimit: 20 } },
    prompts: { id: "prompt", version: "1", system: "x", outputSchema: {} }, provider: { id: "fixture", version: "1", protocol: "fixture", model: "fixture", baseUrl: "fixture://local", timeoutSeconds: 30, retries: 0, endpointPolicy: { allowedHosts: [] } },
    protocol: { contractId: "c", contractVersion: "1", timezone: "Asia/Shanghai", runIdPattern: "x", sameDayIdempotent: true, stages: [], activeRuleIds: [], integrity: {}, documents: {}, completionReportFields: [] },
    provenance: { coreVersion: "1", intentVersion: 3, presetVersion: "1", policyVersion: "1", promptVersion: "1", providerVersion: "1", policyOrigin: "packaged", contractVersion: "1", contractDigest: "x" }, origins: {} };
}

const snapshot: ControlPlaneSnapshot = { revision: "before", sources: [source], rules: [], feedback: [], records: [{ kind: "sources", id: source.id, payload: source as unknown as Record<string, unknown>, storeRecordId: "rec-one" }] };

describe("governed source migration", () => {
  it("changes only connector fields and preserves all other remote source governance", () => {
    const migration = parseSourceMigration({ apiVersion: "briefwright.dev/source-migration/v1", sources: [{ id: "SRC-ONE", connector: { type: "in-app-browser", config: { url: "https://example.com/news", allowedHosts: ["example.com"] } } }] });
    const [record] = sourceMigrationRecords(config(), snapshot, migration);
    expect(record).toMatchObject({ id: "SRC-ONE", storeRecordId: "rec-one", payload: { title: "One", priority: 91, coverageDomains: ["模型"], scheduleState: { humanLocked: true }, connector: { type: "in-app-browser" } } });
    const { connector: _beforeConnector, ...before } = source;
    const { connector: _afterConnector, connector_version: connectorVersion, ...after } = record!.payload as unknown as SourceDefinition & { connector_version?: string };
    expect(connectorVersion).toBe("1.0.0");
    expect(after).toEqual(before);
  });

  it("rejects unknown source IDs instead of creating records", () => {
    const migration = parseSourceMigration({ apiVersion: "briefwright.dev/source-migration/v1", sources: [{ id: "SRC-MISSING", connector: { type: "rss", config: { url: "https://example.com/feed.rss" } } }] });
    expect(() => sourceMigrationRecords(config(), snapshot, migration)).toThrow("were not found by stable business ID");
  });

  it("rejects extra fields, unsupported connectors, insecure URLs, and duplicate IDs", () => {
    expect(() => parseSourceMigration({ apiVersion: "briefwright.dev/source-migration/v1", sources: [{ id: "SRC-ONE", title: "override", connector: { type: "rss", config: { url: "https://example.com/feed" } } }] })).toThrow("unexpected keys: title");
    expect(() => parseSourceMigration({ apiVersion: "briefwright.dev/source-migration/v1", sources: [{ id: "SRC-ONE", connector: { type: "extension", config: {} } }] })).toThrow("not supported");
    expect(() => parseSourceMigration({ apiVersion: "briefwright.dev/source-migration/v1", sources: [{ id: "SRC-ONE", connector: { type: "rss", config: { url: "http://example.com/feed" } } }] })).toThrow("HTTPS URL");
    expect(() => parseSourceMigration({ apiVersion: "briefwright.dev/source-migration/v1", sources: [{ id: "SRC-ONE", connector: { type: "rss", config: { url: "https://example.com/feed" } } }, { id: "SRC-ONE", connector: { type: "rss", config: { url: "https://example.com/feed" } } }] })).toThrow("Duplicate");
  });

  it("supports an explicit activation-only change without replacing the connector", () => {
    const migration = parseSourceMigration({ apiVersion: "briefwright.dev/source-migration/v1", sources: [{ id: "SRC-ONE", enabled: false }] });
    const [record] = sourceMigrationRecords(config(), snapshot, migration);
    expect(record).toMatchObject({ id: "SRC-ONE", payload: { enabled: false, connector: source.connector } });
  });

  it("rejects a source entry that changes neither connector nor activation", () => {
    expect(() => parseSourceMigration({ apiVersion: "briefwright.dev/source-migration/v1", sources: [{ id: "SRC-ONE" }] }))
      .toThrow("must change connector or enabled");
  });

  it("binds source writes to the reviewed digest and update count", () => {
    expect(() => assertSourceMigrationAuthorization({ digest: "abc", updates: 3 }, "abc", 3)).not.toThrow();
    expect(() => assertSourceMigrationAuthorization({ digest: "changed", updates: 3 }, "abc", 3)).toThrow(/digest changed/);
    expect(() => assertSourceMigrationAuthorization({ digest: "abc", updates: 2 }, "abc", 3)).toThrow(/update count changed/);
    expect(() => assertSourceMigrationAuthorization({ digest: "abc", updates: 3 })).toThrow(/requires --expect-digest/);
  });

  it("requires a clean canonical plan after source migration readback", () => {
    const clean = { driver: "lark" as const, creates: [], updates: [], unchanged: [], conflicts: [], digest: "abc" };
    expect(() => assertSourceMigrationPostApplyClean(clean)).not.toThrow();
    expect(() => assertSourceMigrationPostApplyClean({ ...clean, updates: [{ kind: "sources", id: "SRC-ONE", payload: {} }] })).toThrow(/updates=1/);
  });

  it("locks the three production source repairs to Computer Use and exact hosts", () => {
    const migration = parseSourceMigration({ apiVersion: "briefwright.dev/source-migration/v1", sources: [
      { id: "SRC-XAI-NEWS", connector: { type: "computer-use", config: { url: "https://x.ai/news", allowedHosts: ["x.ai"] } } },
      { id: "SRC-ORACLE-AI-BLOG", connector: { type: "computer-use", config: { url: "https://blogs.oracle.com/ai-and-datascience/", allowedHosts: ["blogs.oracle.com"] } } },
      { id: "SRC-VOLCENGINE-AI", connector: { type: "computer-use", config: { url: "https://docs.volcengine.com/docs/82379/?lang=zh", allowedHosts: ["docs.volcengine.com"] } } },
    ] });

    expect(migration.sources.map((entry) => entry.connector)).toEqual([
      { type: "computer-use", config: { url: "https://x.ai/news", allowedHosts: ["x.ai"] } },
      { type: "computer-use", config: { url: "https://blogs.oracle.com/ai-and-datascience/", allowedHosts: ["blogs.oracle.com"] } },
      { type: "computer-use", config: { url: "https://docs.volcengine.com/docs/82379/?lang=zh", allowedHosts: ["docs.volcengine.com"] } },
    ]);
  });
});
