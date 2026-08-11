import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/commands/init.js";
import { loadEffectiveConfig } from "../src/config/load.js";
import { evaluateCadence } from "../src/core/cadence.js";
import { SqliteStateStore } from "../src/state/sqlite.js";

describe("cadence governance", () => {
  it("proposes a hysteretic downshift only after cold start and keeps approval human-controlled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-cadence-"));
    const config = await loadEffectiveConfig(await initializeProject({ directory: root, yes: true }));
    const store = new SqliteStateStore(config.storage.path, root);
    const source = config.preset.sources[0]!;
    source.coverageDomains = [];
    delete source.domain;
    try {
      store.database.prepare("INSERT INTO config_snapshots(digest,config_json,created_at) VALUES ('x','{}','2026-08-01T00:00:00Z')").run();
      for (let index = 0; index < 11; index += 1) {
        const day = index === 0 ? "01" : String(index + 15).padStart(2, "0");
        const runId = `CADENCE-${index}`;
        const at = index === 0 ? `2026-07-${day}T00:00:00Z` : `2026-08-${day}T00:00:00Z`;
        store.database.prepare("INSERT INTO runs(run_id,generated_at,mode,config_digest,status,result_json) VALUES (?,?,'live','x','success','{}')").run(runId, at);
        store.database.prepare("INSERT INTO receipts(run_id,source_id,result,attempted_at,completed_at) VALUES (?,?, 'unchanged', ?, ?)").run(runId, source.id, at, at);
      }
      expect(evaluateCadence(config, store, new Date("2026-08-31T02:00:00Z")).proposals).toHaveLength(0);
      expect(evaluateCadence(config, store, new Date("2026-09-07T02:00:00Z")).proposals).toHaveLength(0);
      const result = evaluateCadence(config, store, new Date("2026-09-14T02:00:00Z"));
      expect(result.evaluated).toBe(true); expect(result.proposals).toHaveLength(1);
      const proposal = store.cadenceProposals()[0]!;
      expect(proposal).toMatchObject({ sourceId: source.id, currentHours: 24, proposedHours: 168, status: "proposed" });
      store.decideCadenceProposal(proposal.id, "approve");
      expect(store.cadenceProposals()[0]?.status).toBe("approved");
      store.setSourceCadenceLock(source.id, true, 24);
      expect(store.sourceCadenceMetrics(source.id, "2026-07-01T00:00:00Z").humanLocked).toBe(true);
    } finally { store.close(); }
  });

  it("forces mature uncovered domains into the due manifest and blocks cadence downshift", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-coverage-gap-"));
    const config = await loadEffectiveConfig(await initializeProject({ directory: root, yes: true }));
    const store = new SqliteStateStore(config.storage.path, root); const source = config.preset.sources.find((entry) => Boolean(entry.domain))!;
    try {
      store.database.prepare("INSERT INTO config_snapshots(digest,config_json,created_at) VALUES ('x','{}','2026-07-01T00:00:00Z')").run();
      for (let index = 0; index < 11; index += 1) {
        const at = index === 0 ? "2026-07-01T00:00:00Z" : `2026-08-${String(index + 10).padStart(2, "0")}T00:00:00Z`;
        const runId = `GAP-${index}`; store.database.prepare("INSERT INTO runs(run_id,generated_at,mode,config_digest,status,result_json,run_kind) VALUES (?,?,'live','x','success','{}','formal')").run(runId, at);
        store.database.prepare("INSERT INTO receipts(run_id,source_id,result,attempted_at,completed_at) VALUES (?,?,'unchanged',?,?)").run(runId, source.id, at, at);
      }
      const due = store.dueSources([source], new Date("2026-09-14T02:00:00Z"), config.policy.domains);
      expect(due[0]?.reason).toContain("coverage-gap:");
      expect(evaluateCadence({ ...config, preset: { ...config.preset, sources: [source] } }, store, new Date("2026-09-14T02:00:00Z")).proposals).toHaveLength(0);
      expect(store.diagnoseImprovements(new Date("2026-09-14T02:00:00Z"), 30, config.policy.domains).findings).toEqual(expect.arrayContaining([expect.objectContaining({ type: "domain-coverage-gap" })]));
    } finally { store.close(); }
  });
});
