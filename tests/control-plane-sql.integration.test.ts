import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/commands/init.js";
import { loadEffectiveConfig } from "../src/config/load.js";
import { controlPlaneFor } from "../src/control-plane/registry.js";
import { MysqlControlPlane, PostgresControlPlane } from "../src/control-plane/sql.js";

for (const target of [
  { driver: "postgres" as const, env: "BRIEFWRIGHT_TEST_POSTGRES_URL" },
  { driver: "mysql" as const, env: "BRIEFWRIGHT_TEST_MYSQL_URL" },
]) describe(`${target.driver} control-plane contract`, () => {
  it.skipIf(!process.env[target.env])("creates, reads, compares, and transactionally updates canonical records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), `briefwright-${target.driver}-`));
    const configPath = await initializeProject({ directory: root, yes: true, processStore: { driver: target.driver, connection: { provider: "env", key: target.env } } });
    const store = controlPlaneFor(await loadEffectiveConfig(configPath)); const id = `SRC-CI-${target.driver.toUpperCase()}-${Date.now()}`;
    try {
      if (store instanceof PostgresControlPlane || store instanceof MysqlControlPlane) await store.ensureSchema();
      expect(await store.doctor()).toEqual([expect.objectContaining({ ok: true, detail: expect.stringContaining("read-only") })]);
      const first = await store.plan([{ kind: "sources", id, payload: { id, title: "CI source", connector: { type: "webpage", config: { url: "https://example.com" } } } }]);
      expect(first.creates).toHaveLength(1); expect((await store.apply(first)).failed).toEqual([]);
      expect((await store.pull()).records).toContainEqual(expect.objectContaining({ kind: "sources", id, payload: expect.objectContaining({ title: "CI source" }) }));
      const unchanged = await store.plan([{ kind: "sources", id, payload: { id, title: "CI source", connector: { type: "webpage", config: { url: "https://example.com" } } } }]);
      expect(unchanged.unchanged).toHaveLength(1);
      const update = await store.plan([{ kind: "sources", id, payload: { id, title: "CI source updated", connector: { type: "webpage", config: { url: "https://example.com" } } } }]);
      expect(update.updates).toHaveLength(1); expect((await store.apply(update)).updated).toBe(1);
    } finally { await store.close(); }
  }, 30_000);
});
