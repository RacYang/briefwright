#!/usr/bin/env node

import path from "node:path";

import { Command } from "commander";

import { explainConfiguration, renderConfiguration, validateConfiguration } from "./commands/config.js";
import { runDemo } from "./commands/demo.js";
import { runDoctor } from "./commands/doctor.js";
import { initializeProject } from "./commands/init.js";
import { previewProject } from "./commands/preview.js";
import { ConfigurationError } from "./config/load.js";

const program = new Command();

program
  .name("briefwright")
  .description("Source-linked, auditable intelligence briefings without the setup wall.")
  .version("0.0.0");

program
  .command("demo")
  .description("Generate an offline demonstration briefing with bundled fixture data.")
  .option("--directory <path>", "demo data directory")
  .action(async ({ directory }: { directory?: string }) => {
    const result = await runDemo(directory ? path.resolve(directory) : undefined);
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
    const configPath = await initializeProject({
      directory: options.directory,
      yes: options.yes,
      ...(options.name ? { name: options.name } : {}),
      ...(options.interest ? { interests: options.interest } : {}),
    });
    console.log(`Created ${configPath}`);
    console.log("Schedule: manual (nothing was enabled).\n");
    console.log(`Next: briefwright preview --config ${configPath}`);
  });

program
  .command("preview")
  .description("Validate the project and generate a local fixture preview without scheduling.")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => {
    const result = await previewProject(config);
    console.log("Preview complete (bundled example data; no schedule was enabled).\n");
    console.log(`Briefing: ${result.outputPath}`);
    console.log(`Items: ${result.itemCount}`);
    console.log(`Source receipts: ${result.receiptCount}`);
  });

const configCommand = program.command("config").description("Validate and explain compiled configuration.");

configCommand
  .command("validate")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => {
    await validateConfiguration(config);
    console.log(`Configuration is valid: ${path.resolve(config)}`);
  });

configCommand
  .command("render")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => {
    console.log(await renderConfiguration(config));
  });

configCommand
  .command("explain")
  .argument("<field>")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async (field: string, { config }: { config: string }) => {
    console.log(await explainConfiguration(config, field));
  });

program
  .command("doctor")
  .description("Check configuration and the local runtime environment.")
  .option("-c, --config <path>", "intent configuration", "briefing.yaml")
  .action(async ({ config }: { config: string }) => {
    const checks = await runDoctor(config);
    for (const check of checks) {
      console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
    }
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
  });

try {
  await program.parseAsync();
} catch (error) {
  if (error instanceof ConfigurationError) {
    console.error(error.message);
    for (const problem of error.problems) console.error(`- ${problem}`);
    console.error("\nNext: fix briefing.yaml, then run 'briefwright config validate'.");
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
}

