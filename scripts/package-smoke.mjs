import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const tarball = `briefwright-${packageVersion}.tgz`;
execFileSync("npm", ["pack", "--ignore-scripts"], { cwd: root, stdio: "inherit" });
if (!existsSync(path.join(root, tarball))) throw new Error(`npm pack did not produce ${tarball}`);
const project = realpathSync(mkdtempSync(path.join(tmpdir(), "briefwright-package-")));
execFileSync("npm", ["init", "-y"], { cwd: project, stdio: "ignore" });
execFileSync("npm", ["install", path.join(root, tarball), "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", "--fetch-retries=1", "--fetch-timeout=15000"], {
  cwd: project,
  stdio: "inherit",
  timeout: 120_000,
});
const cli = path.join(project, "node_modules", ".bin", process.platform === "win32" ? "briefwright.cmd" : "briefwright");
const output = execFileSync(cli, ["--json", "capabilities"], { cwd: project, encoding: "utf8" });
const parsed = JSON.parse(output);
const cliVersion = execFileSync(cli, ["--version"], { cwd: project, encoding: "utf8" }).trim();
if (!parsed.ok || parsed.version !== packageVersion || cliVersion !== packageVersion || !parsed.formalRuns || !parsed.scheduling || !parsed.knowledgeWrites || !parsed.commands.includes("skill")) {
  throw new Error("Packaged capability or version smoke test failed");
}
const listed = execFileSync("tar", ["-tf", path.join(root, tarball)], { encoding: "utf8" });
for (const required of ["package/README.md", "package/README.zh-CN.md", "package/policies/", "package/prompts/", "package/providers/", "package/protocol/ai-intelligence-contract.v1.json", "package/schemas/control-plane-record.schema.json", "package/skill/briefwright/SKILL.md"]) {
  if (!listed.includes(required)) throw new Error(`Package is missing ${required}`);
}

const beginner = path.join(project, "first-briefing");
const setup = JSON.parse(execFileSync(cli, ["--json", "setup", "--yes", "--directory", beginner, "--name", "First briefing", "--interest", "AI releases", "--model", "ollama", "--process-store", "sqlite", "--document-store", "local", "--schedule", "manual"], { cwd: project, encoding: "utf8" }));
const preview = JSON.parse(execFileSync(cli, ["--json", "preview", "--config", setup.configPath], { cwd: project, encoding: "utf8" }));
const doctor = JSON.parse(execFileSync(cli, ["--json", "doctor", "--config", setup.configPath], { cwd: project, encoding: "utf8" }));
const status = JSON.parse(execFileSync(cli, ["--json", "status", "--config", setup.configPath], { cwd: project, encoding: "utf8" }));
if (!setup.ok || setup.choices.processStore !== "sqlite" || setup.choices.documentStore !== "local" || !preview.ok || preview.mode !== "fixture" || !doctor.ok || !status.ok || status.scheduleEnabled) {
  throw new Error("Clean-package zero-configuration onboarding failed");
}

const skillDestination = path.join(project, "codex-skills", "briefwright");
const skillInstall = JSON.parse(execFileSync(cli, ["--json", "skill", "install", "--yes", "--destination", skillDestination], { cwd: project, encoding: "utf8" }));
const skillState = JSON.parse(execFileSync(cli, ["--json", "skill", "status", "--destination", skillDestination], { cwd: project, encoding: "utf8" }));
if (!skillInstall.ok || !skillState.ok || !skillState.installed || !skillState.managed || !skillState.intact || skillState.version !== packageVersion) {
  throw new Error("Packaged conversational Skill installation failed");
}

console.log(JSON.stringify({ ok: true, tarball, project, capabilities: parsed, beginner: { setup, preview, doctor, status }, skill: skillState }, null, 2));
