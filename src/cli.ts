#!/usr/bin/env node

import path from "node:path";
import { readFileSync } from "node:fs";

import { Command } from "commander";

import { diffConfiguration, ejectConfiguration, explainConfiguration, renderConfiguration, validateConfiguration } from "./commands/config.js";
import { decideProjectCadence, evaluateProjectCadence, listCadenceProposals, lockSourceCadence } from "./commands/cadence.js";
import { runDemo } from "./commands/demo.js";
import { runDoctor } from "./commands/doctor.js";
import { addProjectFeedback, projectFeedbackSummary, FEEDBACK_TYPES } from "./commands/feedback.js";
import { initializeProject } from "./commands/init.js";
import { setupProject } from "./commands/setup.js";
import { importContract, importLarkSnapshot, provisionLarkProject, syncProject } from "./commands/import-sync.js";
import { diagnoseProject, listImprovementProposals } from "./commands/improve.js";
import { commitKnowledge, proposeKnowledge } from "./commands/knowledge.js";
import { createPolicyExperiment, evaluatePolicyExperiment, transitionPolicyExperiment } from "./commands/experiment.js";
import { migrateConfiguration, migrateProjectDatabase } from "./commands/migrate.js";
import { latestArtifactPath, launchProjectArtifact } from "./commands/open.js";
import { previewProject } from "./commands/preview.js";
import { verifyReplay } from "./commands/replay.js";
import { projectStatus } from "./commands/status.js";
import { describeSchedule, describeCodexAutomation, disableProjectSchedule, enableSchedule, scheduleStatus } from "./commands/schedule.js";
import { runFormalProject } from "./core/run.js";
import { ConfigurationError } from "./config/load.js";
import { provisionSqlProject } from "./commands/sql.js";
import { externalCaptureManifest, validateExternalCaptureFile } from "./commands/capture.js";

const program = new Command();
const VERSION = String((JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: unknown }).version);
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
  .version(VERSION)
  .option("--json", "emit bounded machine-readable output", false);

if (jsonRequested) program.exitOverride();
program.configureOutput({
  writeErr: (message) => {
    if (!jsonRequested) process.stderr.write(message);
  },
});

program.command("setup")
  .description("Guided setup for model, process store, document destination, and schedule.")
  .option("-d, --directory <path>", "project directory", process.cwd())
  .option("-y, --yes", "use supplied options without prompts", false)
  .option("--name <name>", "briefing name")
  .option("--interest <topic...>", "topics to watch")
  .option("--model <provider>", "codex, openai, anthropic, gemini, qwen, ollama, or a packaged provider")
  .option("--process-store <driver>", "lark, postgres, mysql, or sqlite")
  .option("--lark-base <token>", "Feishu Base app token used by lark-cli")
  .option("--connection-env <name>", "environment variable containing a PostgreSQL/MySQL connection URL")
  .option("--document-store <driver>", "obsidian or local")
  .option("--document-root <path>", "Obsidian vault root")
  .option("--schedule <schedule>", "manual, daily-at-10, or weekdays-at-09")
  .action(async (options: { directory: string; yes: boolean; name?: string; interest?: string[]; model?: string; processStore?: "lark" | "postgres" | "mysql" | "sqlite"; larkBase?: string; connectionEnv?: string; documentStore?: "obsidian" | "local"; documentRoot?: string; schedule?: "manual" | "daily-at-10" | "weekdays-at-09" }) => {
    const result = await setupProject({ directory: options.directory, yes: options.yes || isJsonOutput(),
      ...(options.name ? { name: options.name } : {}), ...(options.interest ? { interests: options.interest } : {}), ...(options.model ? { model: options.model } : {}),
      ...(options.processStore ? { processStore: options.processStore } : {}), ...(options.larkBase ? { larkBase: options.larkBase } : {}),
      ...(options.connectionEnv ? { connectionEnv: options.connectionEnv } : {}), ...(options.documentStore ? { documentStore: options.documentStore } : {}),
      ...(options.documentRoot ? { documentRoot: options.documentRoot } : {}), ...(options.schedule ? { schedule: options.schedule } : {}) });
    if (isJsonOutput()) return writeJson({ ok: true, command: "setup", ...result });
    console.log(`Created ${result.configPath}`); console.log(`Model: ${result.choices.model}`); console.log(`Process data: ${result.choices.processStore}`); console.log(`Documents: ${result.choices.documentStore}`);
    console.log("\nNext:"); for (const next of result.next) console.log(`  ${next}`);
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
  .option("--capture-bundle <path>", "validated browser capture bundle for configured external sources")
  .action(async ({ config, retryFailed, captureBundle }: { config: string; retryFailed: boolean; captureBundle?: string }) => {
    const result = await runFormalProject(config, { retryFailed, ...(captureBundle ? { captureBundlePath: captureBundle } : {}) });
    if (isJsonOutput()) {
      writeJson({
        ok: result.outcome !== "failed",
        command: "run",
        runId: result.runId,
        outcome: result.outcome,
        resumed: result.resumed,
        alreadyComplete: result.alreadyComplete,
        remoteExisting: result.remoteExisting ?? false,
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
        controlPlaneSync: result.result.controlPlaneSync,
        completionReport: result.result.completionReport,
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

const captureCommand = program.command("capture").description("Prepare and validate read-only external browser capture bundles.");
captureCommand.command("manifest").option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => { const manifest = await externalCaptureManifest(config); if (isJsonOutput()) return writeJson({ ok: true, command: "capture manifest", ...manifest }); console.log(JSON.stringify(manifest, null, 2)); });
captureCommand.command("validate").argument("<bundle>").option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async (bundle: string, { config }: { config: string }) => { const result = await validateExternalCaptureFile(config, bundle); if (isJsonOutput()) return writeJson({ ok: true, command: "capture validate", ...result }); console.log(JSON.stringify(result, null, 2)); });

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

const importCommand = program.command("import").description("Read an existing control plane or execution contract into a versioned local snapshot.");
importCommand.command("lark")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => { const result = await importLarkSnapshot(config); if (isJsonOutput()) return writeJson({ ok: true, command: "import lark", ...result }); console.log(`Imported ${result.sourceCount} sources and ${result.ruleCount} rules to ${result.outputPath}`); });
importCommand.command("contract")
  .argument("<path>")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async (contractPath: string, { config }: { config: string }) => { const result = await importContract(config, contractPath); if (isJsonOutput()) return writeJson({ ok: true, command: "import contract", ...result }); console.log(`Imported contract ${result.contentDigest} to ${result.outputPath}`); });

const larkCommand = program.command("lark").description("Provision or inspect the recommended Feishu Base control plane through lark-cli.");
larkCommand.command("provision")
  .description("Idempotently create missing standard tables and fields; never deletes or renames data.")
  .requiredOption("--yes", "confirm external Base schema writes")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => {
    const result = await provisionLarkProject(config);
    if (isJsonOutput()) return writeJson({ ok: result.ready, command: "lark provision", ...result });
    console.log(`Lark Base ${result.ready ? "is ready" : "needs attention"}.`);
    console.log(`Created tables: ${result.createdTables.join(", ") || "none"}`);
    console.log(`Created fields: ${result.createdFields.join(", ") || "none"}`);
    for (const check of result.checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
    if (!result.ready) process.exitCode = 1;
  });

const sqlCommand = program.command("sql").description("Provision the canonical PostgreSQL or MySQL process-store schema.");
sqlCommand.command("provision")
  .description("Create the versioned canonical tables in an explicitly configured SQL database.")
  .requiredOption("--yes", "confirm external database schema writes")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => {
    const result = await provisionSqlProject(config);
    if (isJsonOutput()) return writeJson({ ok: result.ready, command: "sql provision", ...result });
    console.log(`${result.driver} process store ${result.ready ? "is ready" : "needs attention"}.`);
    for (const check of result.checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
    if (!result.ready) process.exitCode = 1;
  });

const syncCommand = program.command("sync").description("Plan or explicitly apply local process records to the configured process store.");
syncCommand.command("plan").option("-c, --config <path>", "intent configuration", "briefing.yaml").option("--run <id>")
  .action(async ({ config, run }: { config: string; run?: string }) => { const result = await syncProject(config, false, false, run); if (isJsonOutput()) return writeJson({ ok: true, command: "sync plan", ...result }); console.log(JSON.stringify(result, null, 2)); });
syncCommand.command("apply").requiredOption("--yes", "confirm external process-store writes").option("-c, --config <path>", "intent configuration", "briefing.yaml").option("--run <id>")
  .action(async ({ config, run }: { config: string; run?: string }) => { const result = await syncProject(config, true, true, run); if (isJsonOutput()) return writeJson({ ok: true, command: "sync apply", ...result }); console.log(JSON.stringify(result, null, 2)); });

const feedbackCommand = program.command("feedback").description("Record human outcome signals without changing policy automatically.");
feedbackCommand.command("add")
  .argument("<item-id>")
  .requiredOption("--type <type>", FEEDBACK_TYPES.join(", "))
  .option("--note <text>")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async (itemId: string, options: { type: string; note?: string; config: string }) => {
    const allowed = FEEDBACK_TYPES;
    if (!allowed.includes(options.type as typeof allowed[number])) throw new Error(`Unknown feedback type: ${options.type}`);
    const result = await addProjectFeedback(options.config, itemId, options.type as typeof allowed[number], options.note);
    if (isJsonOutput()) return writeJson({ ok: true, command: "feedback add", itemId, type: options.type, ...result });
    console.log(`Recorded ${options.type} feedback for ${itemId}: ${result.feedbackId}`);
  });

const improveCommand = program.command("improve").description("Diagnose durable signals and create non-active, human-governed improvement proposals.");
improveCommand.command("diagnose").option("-c, --config <path>", "intent configuration", "briefing.yaml").option("--window <days>", "analysis window", "30")
  .action(async ({ config, window }: { config: string; window: string }) => { const result = await diagnoseProject(config, Number(window)); if (isJsonOutput()) return writeJson({ ok: true, command: "improve diagnose", automaticActivation: false, ...result }); console.log(JSON.stringify(result, null, 2)); console.log("No proposal was activated. Review evidence and create a frozen experiment before approval."); });
improveCommand.command("list").option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => { const proposals = await listImprovementProposals(config); if (isJsonOutput()) return writeJson({ ok: true, command: "improve list", proposals }); console.log(JSON.stringify(proposals, null, 2)); });
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
scheduleCommand.command("codex")
  .description("Export a Codex Desktop independent-task automation definition without installing it.")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => { const definition = await describeCodexAutomation(config); if (isJsonOutput()) return writeJson({ ok: true, command: "schedule codex", installed: false, definition }); console.log(JSON.stringify(definition, null, 2)); console.log("Nothing was installed. Review this definition, then create the automation in Codex Desktop."); });
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
  .option("--all-sources", "with --online, probe every enabled source instead of only sources currently due", false)
  .action(async ({ config, online, allSources }: { config: string; online: boolean; allSources: boolean }) => {
    const checks = await runDoctor(config, { online, allSources });
    const blockingFailures = checks.filter((check) => !check.ok && check.blocking !== false);
    if (isJsonOutput()) {
      writeJson({ ok: blockingFailures.length === 0, command: "doctor", checks });
      if (blockingFailures.length) process.exitCode = 1;
      return;
    }
    for (const check of checks) {
      console.log(`${check.ok ? "PASS" : check.blocking === false ? "WARN" : "FAIL"} ${check.name}: ${check.detail}`);
    }
    if (blockingFailures.length) process.exitCode = 1;
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
    if (!print) await launchProjectArtifact(config, artifactPath);
    console.log(artifactPath);
  });

program
  .command("capabilities")
  .description("Describe the installed CLI surface and safety-relevant feature state.")
  .action(() => {
    const capabilities = {
      version: VERSION,
      commands: ["demo", "setup", "init", "preview", "run", "capture", "replay", "status", "open", "doctor", "import", "lark", "sql", "sync", "config", "db", "schedule", "enable", "feedback", "improve", "experiment", "cadence", "knowledge", "capabilities"],
      connectors: ["rss", "github-releases", "webpage", "x-api", "codex-browser", "extension-sdk"],
      providers: ["codex", "openai", "anthropic", "gemini", "qwen", "ollama", "custom-openai-compatible", "custom-protocol", "fixture"],
      processStores: ["lark-cli", "postgres", "mysql", "sqlite-fallback"],
      documentStores: ["obsidian", "local-folder-fallback"],
      presets: ["ai-daily"],
      fixturePreview: true,
      livePreview: true,
      formalRuns: true,
      incrementalCursors: true,
      dailyReviewSelection: true,
      replayAllArtifacts: true,
      feedbackExperiments: true,
      scheduling: true,
      controlPlaneSync: true,
      governedImprovement: true,
      externalDestinations: true,
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
