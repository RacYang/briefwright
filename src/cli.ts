#!/usr/bin/env node

import path from "node:path";

import { Command } from "commander";

import { diffConfiguration, ejectConfiguration, explainConfiguration, renderConfiguration, validateConfiguration } from "./commands/config.js";
import { decideProjectCadence, evaluateProjectCadence, listCadenceProposals, lockSourceCadence } from "./commands/cadence.js";
import { runDemo } from "./commands/demo.js";
import { runDoctor } from "./commands/doctor.js";
import { addProjectFeedback, projectFeedbackSummary } from "./commands/feedback.js";
import { initializeProject } from "./commands/init.js";
import { commitKnowledge, proposeKnowledge } from "./commands/knowledge.js";
import { createPolicyExperiment, evaluatePolicyExperiment, transitionPolicyExperiment } from "./commands/experiment.js";
import { migrateConfiguration, migrateProjectDatabase } from "./commands/migrate.js";
import { latestArtifactPath, launchArtifact } from "./commands/open.js";
import { previewProject } from "./commands/preview.js";
import { verifyReplay } from "./commands/replay.js";
import { projectStatus } from "./commands/status.js";
import { describeSchedule, disableProjectSchedule, enableSchedule, scheduleStatus } from "./commands/schedule.js";
import { runFormalProject } from "./core/run.js";
import { ConfigurationError } from "./config/load.js";

const program = new Command();
const jsonRequested = process.argv.includes("--json");

function isJsonOutput(): boolean {
  return jsonRequested || Boolean(program.opts().json);
}

function writeJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

program
  .name("briefwright")
  .description("Source-linked, auditable intelligence briefings without the setup wall.")
  .version("0.2.0")
  .option("--json", "emit bounded machine-readable output", false);

if (jsonRequested) program.exitOverride();
program.configureOutput({
  writeErr: (message) => {
    if (!jsonRequested) process.stderr.write(message);
  },
});

program
  .command("demo")
  .description("Generate an offline demonstration briefing with bundled fixture data.")
  .option("--directory <path>", "demo data directory")
  .action(async ({ directory }: { directory?: string }) => {
    const result = await runDemo(directory ? path.resolve(directory) : undefined);
    if (isJsonOutput()) {
      writeJson({ ok: true, command: "demo", dataMode: "fixture", ...result });
      return;
    }
    console.log("Briefwright demo complete (bundled example data).\n");
    console.log(`Briefing: ${result.outputPath}`);
    console.log(`Items: ${result.itemCount}`);
    console.log(`Source receipts: ${result.receiptCount}`);
    console.log("\nNext: run 'briefwright init' in a project directory.");
  });

program
  .command("init")
  .description("Create one small briefing.yaml without enabling a schedule.")
  .option("-d, --directory <path>", "project directory", process.cwd())
  .option("-y, --yes", "accept recommended defaults", false)
  .option("--name <name>", "briefing name")
  .option("--interest <topic...>", "topics to watch")
  .action(async (options: { directory: string; yes: boolean; name?: string; interest?: string[] }) => {
    if (isJsonOutput() && !options.yes && (!options.name || !options.interest?.length)) {
      throw new Error("JSON init is non-interactive; pass --yes or provide both --name and --interest");
    }
    const configPath = await initializeProject({
      directory: options.directory,
      yes: options.yes || isJsonOutput(),
      ...(options.name ? { name: options.name } : {}),
      ...(options.interest ? { interests: options.interest } : {}),
    });
    if (isJsonOutput()) {
      writeJson({ ok: true, command: "init", configPath, scheduleEnabled: false });
      return;
    }
    console.log(`Created ${configPath}`);
    console.log("Schedule: manual (nothing was enabled).\n");
    console.log(`Next: briefwright preview --config ${configPath}`);
  });

program
  .command("preview")
  .description("Validate the project and generate a local fixture preview without scheduling.")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .option("--live", "read the preset's public sources instead of bundled fixtures", false)
  .action(async ({ config, live }: { config: string; live: boolean }) => {
    const result = await previewProject(config, { live });
    if (isJsonOutput()) {
      writeJson({ ok: result.outcome !== "failed", command: "preview", scheduleEnabled: false, ...result });
      if (result.outcome === "failed") process.exitCode = 1;
      return;
    }
    console.log(
      result.mode === "live"
        ? "Live preview complete (no schedule was enabled).\n"
        : "Preview complete (bundled example data; no schedule was enabled).\n",
    );
    console.log(`Briefing: ${result.outputPath}`);
    console.log(`Items: ${result.itemCount}`);
    console.log(`Source receipts: ${result.receiptCount}`);
    console.log(`Outcome: ${result.outcome}`);
    for (const failure of result.failedReceipts) {
      console.log(`FAILED ${failure.sourceId}: ${failure.detail ?? "No detail was reported"}`);
    }
    if (result.outcome === "failed") process.exitCode = 1;
  });

program
  .command("run")
  .description("Execute the formal incremental briefing pipeline with the configured AI provider.")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .option("--retry-failed", "create or resume an immutable recovery run for the latest failed operations", false)
  .action(async ({ config, retryFailed }: { config: string; retryFailed: boolean }) => {
    const result = await runFormalProject(config, { retryFailed });
    if (isJsonOutput()) {
      writeJson({
        ok: result.outcome !== "failed",
        command: "run",
        runId: result.runId,
        outcome: result.outcome,
        resumed: result.resumed,
        alreadyComplete: result.alreadyComplete,
        dailyPath: result.dailyPath,
        reviewPath: result.reviewPath,
        counts: result.result.receipts.reduce((counts, receipt) => ({ ...counts, [receipt.result]: (counts[receipt.result] ?? 0) + 1 }), {} as Record<string, number>),
        modelFailures: result.result.modelFailures ?? [],
        selected: { daily: result.result.daily.length, review: result.result.review.length, machineOnly: result.result.machineOnly?.length ?? 0 },
        domains: [...new Set([...result.result.daily, ...result.result.review].map((item) => item.domain).filter(Boolean))],
        ruleIds: result.result.ruleIds,
        stageTimings: result.result.stageTimings,
        integrityValidated: result.result.integrityValidated,
        cadenceGovernance: result.result.cadenceGovernance,
      });
      if (result.outcome === "failed") process.exitCode = 1;
      return;
    }
    console.log(`${result.alreadyComplete ? "Formal run already complete" : "Formal run complete"}: ${result.runId}`);
    console.log(`Outcome: ${result.outcome}`);
    console.log(`Daily: ${result.dailyPath}`);
    console.log(`Review: ${result.reviewPath}`);
    for (const failure of result.result.modelFailures ?? []) console.log(`MODEL FAILED ${failure.sourceId}: ${failure.detail}`);
    if (result.outcome === "failed") process.exitCode = 1;
  });

const configCommand = program.command("config").description("Validate and explain compiled configuration.");

configCommand
  .command("validate")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => {
    await validateConfiguration(config);
    if (isJsonOutput()) {
      writeJson({ ok: true, command: "config validate", configPath: path.resolve(config) });
      return;
    }
    console.log(`Configuration is valid: ${path.resolve(config)}`);
  });

configCommand
  .command("render")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => {
    const rendered = await renderConfiguration(config);
    if (isJsonOutput()) {
      writeJson({ ok: true, command: "config render", effectiveConfig: JSON.parse(rendered) });
      return;
    }
    console.log(rendered);
  });

configCommand
  .command("explain")
  .argument("<field>")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async (field: string, { config }: { config: string }) => {
    const explanation = await explainConfiguration(config, field);
    if (isJsonOutput()) {
      writeJson({ ok: true, command: "config explain", field, explanation });
      return;
    }
    console.log(explanation);
  });

configCommand
  .command("migrate")
  .description("Preview or write a versioned briefing.yaml migration.")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .option("--write", "write the migration and create a backup", false)
  .action(async ({ config, write }: { config: string; write: boolean }) => {
    const result = await migrateConfiguration(config, write);
    if (isJsonOutput()) return writeJson({ ok: true, command: "config migrate", ...result });
    console.log(result.changed ? `${write ? "Migrated" : "Migration available"}: v${result.fromVersion} -> v${result.toVersion}` : "Configuration is current.");
    if (!write && result.changed) console.log(result.preview);
    if (result.backupPath) console.log(`Backup: ${result.backupPath}`);
  });

configCommand
  .command("eject")
  .description("Generate fully typed expert resources; ordinary users do not need this.")
  .requiredOption("--yes", "confirm creation of briefwright.d")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => {
    const files = await ejectConfiguration(config);
    if (isJsonOutput()) return writeJson({ ok: true, command: "config eject", files });
    console.log(`Generated ${files.length} expert resource files in briefwright.d.`);
  });

configCommand
  .command("diff")
  .requiredOption("--against <path>", "another briefing.yaml")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config, against }: { config: string; against: string }) => {
    const changes = await diffConfiguration(config, against);
    if (isJsonOutput()) return writeJson({ ok: true, command: "config diff", changes });
    console.log(changes.length ? changes.map((change) => `${change.field}: ${JSON.stringify(change.left)} -> ${JSON.stringify(change.right)}`).join("\n") : "No semantic differences.");
  });

const dbCommand = program.command("db").description("Inspect and migrate local durable state.");
dbCommand
  .command("migrate")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .option("--write", "apply pending migrations and create a backup", false)
  .action(async ({ config, write }: { config: string; write: boolean }) => {
    const result = await migrateProjectDatabase(config, write);
    if (isJsonOutput()) return writeJson({ ok: true, command: "db migrate", ...result });
    console.log(`Database schema: ${result.current}/${result.latest}`);
    console.log(result.applied.length ? `Applied: ${result.applied.join(", ")}` : `Pending: ${result.pending.map((item) => item.version).join(", ") || "none"}`);
    if ("backupPath" in result && result.backupPath) console.log(`Backup: ${result.backupPath}`);
  });

const feedbackCommand = program.command("feedback").description("Record human outcome signals without changing policy automatically.");
feedbackCommand.command("add")
  .argument("<item-id>")
  .requiredOption("--type <type>", "reviewed, used, ignored, or knowledge-worthy")
  .option("--note <text>")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async (itemId: string, options: { type: string; note?: string; config: string }) => {
    const allowed = ["reviewed", "used", "ignored", "knowledge-worthy"] as const;
    if (!allowed.includes(options.type as typeof allowed[number])) throw new Error(`Unknown feedback type: ${options.type}`);
    const result = await addProjectFeedback(options.config, itemId, options.type as typeof allowed[number], options.note);
    if (isJsonOutput()) return writeJson({ ok: true, command: "feedback add", itemId, type: options.type, ...result });
    console.log(`Recorded ${options.type} feedback for ${itemId}: ${result.feedbackId}`);
  });
feedbackCommand.command("summary")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => {
    const result = await projectFeedbackSummary(config);
    if (isJsonOutput()) return writeJson({ ok: true, command: "feedback summary", ...result });
    console.log(JSON.stringify(result, null, 2));
  });

const experimentCommand = program.command("experiment").description("Evaluate policy changes against durable feedback before activation.");
experimentCommand.command("create")
  .requiredOption("--candidate <path>", "candidate policy JSON")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ candidate, config }: { candidate: string; config: string }) => {
    const result = await createPolicyExperiment(config, candidate);
    if (isJsonOutput()) return writeJson({ ok: true, command: "experiment create", ...result });
    console.log(`Created policy experiment: ${result.experimentId}`);
  });
experimentCommand.command("evaluate")
  .argument("<experiment-id>")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async (id: string, { config }: { config: string }) => {
    const result = await evaluatePolicyExperiment(config, id);
    if (isJsonOutput()) return writeJson({ ok: result.eligible, command: "experiment evaluate", experimentId: id, ...result });
    console.log(`${result.eligible ? "ELIGIBLE" : "NOT ELIGIBLE"} ${id}`);
    console.log(JSON.stringify(result.metrics, null, 2));
    if (!result.eligible) process.exitCode = 2;
  });
for (const action of ["approve", "activate", "rollback"] as const) {
  experimentCommand.command(action)
    .argument("<experiment-id>")
    .requiredOption("--yes", `confirm ${action}`)
    .option("-c, --config <path>", "intent configuration", "briefing.yaml")
    .action(async (id: string, { config }: { config: string }) => {
      const result = await transitionPolicyExperiment(config, id, action);
      if (isJsonOutput()) return writeJson({ ok: true, command: `experiment ${action}`, experimentId: id, status: result.status });
      console.log(`${id}: ${result.status}`);
    });
}

const knowledgeCommand = program.command("knowledge").description("Preview and explicitly commit bounded knowledge-note changes.");
knowledgeCommand.command("propose")
  .argument("<item-id>")
  .requiredOption("--target <relative-path>", "Markdown target inside the project")
  .option("--heading <markdown-heading>", "existing heading under which to insert")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async (itemId: string, options: { target: string; heading?: string; config: string }) => {
    const result = await proposeKnowledge(options.config, itemId, options.target, options.heading);
    if (isJsonOutput()) return writeJson({ ok: true, command: "knowledge propose", itemId, committed: false, ...result });
    console.log(`Proposal: ${result.proposalId}`);
    console.log(`Preview: ${result.previewPath}`);
    console.log(`Target: ${result.targetPath}`);
    console.log(`Nothing was written to the knowledge target. Review, then run 'briefwright knowledge commit ${result.proposalId} --yes'.`);
  });
knowledgeCommand.command("commit")
  .argument("<proposal-id>")
  .requiredOption("--yes", "confirm the exact proposed write")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async (proposalId: string, { config }: { config: string }) => {
    const result = await commitKnowledge(config, proposalId);
    if (isJsonOutput()) return writeJson({ ok: true, command: "knowledge commit", committed: true, ...result });
    console.log(`Committed ${proposalId} to ${result.targetPath}`);
  });

const scheduleCommand = program.command("schedule").description("Describe or explicitly manage a native user schedule.");
scheduleCommand.command("describe")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .option("--platform <platform>", "darwin, linux, or win32")
  .action(async ({ config, platform }: { config: string; platform?: "darwin" | "linux" | "win32" }) => {
    const { definition } = await describeSchedule(config, platform);
    if (isJsonOutput()) return writeJson({ ok: true, command: "schedule describe", installed: false, definition });
    console.log(definition.native);
    console.log("Nothing was installed.");
  });
scheduleCommand.command("enable")
  .requiredOption("--yes", "confirm native schedule installation")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => {
    const result = await enableSchedule(config);
    if (isJsonOutput()) return writeJson({ ok: true, command: "schedule enable", installed: true, ...result });
    console.log(`Enabled ${result.scheduleId} at ${result.location}`);
  });
scheduleCommand.command("disable")
  .requiredOption("--yes", "confirm native schedule removal")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => {
    const result = await disableProjectSchedule(config);
    if (isJsonOutput()) return writeJson({ ok: true, command: "schedule disable", ...result });
    console.log(`Disabled ${result.scheduleId}`);
  });
scheduleCommand.command("status")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => {
    const result = await scheduleStatus(config);
    if (isJsonOutput()) return writeJson({ ok: true, command: "schedule status", ...result });
    console.log(JSON.stringify(result, null, 2));
  });

const cadenceCommand = program.command("cadence").description("Review source-cadence proposals with hysteresis and human locks.");
cadenceCommand.command("evaluate")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => {
    const result = await evaluateProjectCadence(config);
    if (isJsonOutput()) return writeJson({ ok: true, command: "cadence evaluate", ...result });
    console.log(JSON.stringify(result, null, 2));
  });
cadenceCommand.command("list")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => {
    const result = await listCadenceProposals(config);
    if (isJsonOutput()) return writeJson({ ok: true, command: "cadence list", proposals: result });
    console.log(JSON.stringify(result, null, 2));
  });
for (const decision of ["approve", "reject"] as const) cadenceCommand.command(decision)
  .argument("<proposal-id>")
  .requiredOption("--yes", `confirm ${decision}`)
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async (id: string, { config }: { config: string }) => {
    const result = await decideProjectCadence(config, id, decision);
    if (isJsonOutput()) return writeJson({ ok: true, command: `cadence ${decision}`, ...result });
    console.log(`${result.id}: ${result.status}`);
  });
cadenceCommand.command("lock")
  .argument("<source-id>")
  .requiredOption("--yes", "confirm human cadence lock")
  .option("--unlock", "remove the human cadence lock", false)
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async (sourceId: string, { config, unlock }: { config: string; unlock: boolean }) => {
    const result = await lockSourceCadence(config, sourceId, !unlock);
    if (isJsonOutput()) return writeJson({ ok: true, command: "cadence lock", ...result });
    console.log(`${sourceId}: ${result.locked ? "locked" : "unlocked"}`);
  });

program.command("enable")
  .description("Enable the configured schedule after explicit confirmation.")
  .requiredOption("--yes", "confirm native schedule installation")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => {
    const result = await enableSchedule(config);
    if (isJsonOutput()) return writeJson({ ok: true, command: "enable", installed: true, ...result });
    console.log(`Enabled ${result.scheduleId} at ${result.location}`);
  });

program
  .command("doctor")
  .description("Check configuration and the local runtime environment.")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .option("--online", "also call the configured provider and source endpoints", false)
  .action(async ({ config, online }: { config: string; online: boolean }) => {
    const checks = await runDoctor(config, { online });
    if (isJsonOutput()) {
      writeJson({ ok: checks.every((check) => check.ok), command: "doctor", checks });
      if (checks.some((check) => !check.ok)) process.exitCode = 1;
      return;
    }
    for (const check of checks) {
      console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
    }
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
  });

program
  .command("replay")
  .description("Re-render a recorded run snapshot and verify its artifact hash without network access.")
  .argument("<run-id>")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async (runId: string, { config }: { config: string }) => {
    const result = await verifyReplay(config, runId);
    if (isJsonOutput()) {
      writeJson({ ok: result.matches, command: "replay", ...result });
      if (!result.matches) process.exitCode = 1;
      return;
    }
    console.log(`${result.matches ? "PASS" : "FAIL"} replay ${runId}`);
    console.log(`Artifact: ${result.artifactPath}`);
    if (!result.matches) process.exitCode = 1;
  });

program
  .command("status")
  .description("Show schedule state and the latest local run.")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => {
    const status = await projectStatus(config);
    if (isJsonOutput()) {
      writeJson({ ok: true, command: "status", ...status });
      return;
    }
    console.log(`Schedule: ${status.scheduleEnabled ? "enabled" : "not enabled"}`);
    if (!status.scheduleInSync) console.log(`Schedule drift: local state and ${status.nativeSchedule?.location ?? "native scheduler"} disagree`);
    if (!status.latestRun) {
      console.log("Latest run: none");
      console.log("Next: briefwright preview");
      return;
    }
    console.log(`Latest run: ${status.latestRun.runId} (${status.latestRun.status})`);
    console.log(`Generated: ${status.latestRun.generatedAt}`);
    console.log(
      `Sources: ${status.latestRun.observed} observed, ${status.latestRun.updated} updated, ${status.latestRun.unchanged} unchanged, ${status.latestRun.failed} failed, ${status.latestRun.skipped} skipped`,
    );
    if (status.latestRun.artifactPath) console.log(`Briefing: ${status.latestRun.artifactPath}`);
  });

program
  .command("open")
  .description("Open the latest local briefing artifact.")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .option("--print", "print the path without launching an application", false)
  .action(async ({ config, print }: { config: string; print: boolean }) => {
    const artifactPath = await latestArtifactPath(config);
    if (isJsonOutput()) {
      writeJson({ ok: true, command: "open", launched: false, artifactPath });
      return;
    }
    if (!print) launchArtifact(artifactPath);
    console.log(artifactPath);
  });

program
  .command("capabilities")
  .description("Describe the installed CLI surface and safety-relevant feature state.")
  .action(() => {
    const capabilities = {
      version: "0.2.0",
      commands: ["demo", "init", "preview", "run", "replay", "status", "open", "doctor", "config", "db", "schedule", "enable", "feedback", "experiment", "cadence", "knowledge", "capabilities"],
      connectors: ["rss", "github-releases"],
      providers: ["qwen", "fixture"],
      presets: ["ai-daily"],
      fixturePreview: true,
      livePreview: true,
      formalRuns: true,
      incrementalCursors: true,
      dailyReviewSelection: true,
      replayAllArtifacts: true,
      feedbackExperiments: true,
      scheduling: true,
      externalDestinations: false,
      knowledgeWrites: true,
    };
    if (isJsonOutput()) {
      writeJson({ ok: true, command: "capabilities", ...capabilities });
      return;
    }
    console.log(JSON.stringify(capabilities, null, 2));
  });

try {
  await program.parseAsync();
} catch (error) {
  if (isJsonOutput()) {
    writeJson({
      ok: false,
      error: {
        code: error instanceof ConfigurationError ? "CONFIG_INVALID" : "COMMAND_FAILED",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof ConfigurationError ? { problems: error.problems } : {}),
      },
    });
    process.exitCode = 1;
  } else if (error instanceof ConfigurationError) {
    console.error(error.message);
    for (const problem of error.problems) console.error(`- ${problem}`);
    console.error("\nNext: fix briefing.yaml, then run 'briefwright config validate'.");
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
}
