import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/commands/init.js";
import { runFormalProject } from "../src/core/run.js";
import type { LarkRunner } from "../src/control-plane/lark-cli.js";

const rules = [
  ["RULE-WORKFLOW-V1.3", "1.3"], ["RULE-SCORE-V1.0", "1.0"],
  ["RULE-SELECTION-V1.1", "1.1"], ["RULE-SOURCE-V1.1", "1.1"],
  ["RULE-IMPROVEMENT-V1.0", "1.0"], ["RULE-RETENTION-V1.0", "1.0"],
  ["RULE-REVIEW-OUTPUT-V1.1", "1.1"],
];

describe("production migration idempotence", () => {
  it("adopts a terminal remote run and never replaces its existing documents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-remote-run-"));
    const configPath = await initializeProject({ directory: root, yes: true, processStore: { driver: "lark", baseToken: "base-test" } });
    const dailyPath = path.join(root, "briefs/Daily/2026-08-11-AI情报简报.md");
    const reviewPath = path.join(root, "briefs/Review/2026-08-11-AI情报待复核.md");
    await mkdir(path.dirname(dailyPath), { recursive: true }); await mkdir(path.dirname(reviewPath), { recursive: true });
    await writeFile(dailyPath, "---\nrun_id: RUN-20260811-DAILY\n---\nexisting daily\n", "utf8");
    await writeFile(reviewPath, "---\nrun_id: RUN-20260811-DAILY\n---\nexisting review\n", "utf8");
    const runner: LarkRunner = (args) => {
      if (!args.includes("+record-list")) throw new Error(`unexpected write or command: ${args.join(" ")}`);
      if (args.includes("Run ID")) return { record_id_list: ["rec-run"], fields: ["Run ID", "状态", "开始时间", "结束时间"], data: [["RUN-20260811-DAILY", "部分成功", "2026-08-11 10:00:00", "2026-08-11 10:10:00"]], has_more: false };
      if (args.includes("Rule ID")) return { record_id_list: rules.map((_, index) => `rec-rule-${index}`), fields: ["Rule ID", "版本", "标题", "状态"], data: rules.map(([id, version]) => [id, version, id, ["生效中"]]), has_more: false };
      return { record_id_list: [], fields: [], data: [], has_more: false };
    };

    const result = await runFormalProject(configPath, { now: new Date("2026-08-11T02:20:00Z"), larkRunner: runner });
    expect(result).toMatchObject({ runId: "RUN-20260811-DAILY", outcome: "partial", alreadyComplete: true, remoteExisting: true });
    expect(await readFile(dailyPath, "utf8")).toContain("existing daily");
    expect(await readFile(reviewPath, "utf8")).toContain("existing review");
  });
});
