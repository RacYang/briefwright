#!/usr/bin/env node

import path from "node:path";

import { Command } from "commander";

import { explainConfiguration, renderConfiguration, validateConfiguration } from "./commands/config.js";
import { runDemo } from "./commands/demo.js";
import { runDoctor } from "./commands/doctor.js";
import { initializeProject } from "./commands/init.js";
import { latestArtifactPath, launchArtifact } from "./commands/open.js";
import { previewProject } from "./commands/preview.js";
import { verifyReplay } from "./commands/replay.js";
import { projectStatus } from "./commands/status.js";
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
  .version("0.1.0-alpha.1")
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

program
  .command("doctor")
  .description("Check configuration and the local runtime environment.")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => {
    const checks = await runDoctor(config);
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
      version: "0.1.0-alpha.1",
      commands: ["demo", "init", "preview", "replay", "status", "open", "doctor", "config"],
      connectors: ["rss", "github-releases"],
      presets: ["ai-daily"],
      fixturePreview: true,
      livePreview: true,
      scheduling: false,
      externalDestinations: false,
      knowledgeWrites: false,
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
