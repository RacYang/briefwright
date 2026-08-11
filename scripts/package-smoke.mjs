import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const tarball = `briefwright-${packageVersion}.tgz`;
execFileSync("npm", ["pack", "--ignore-scripts"], { cwd: root, stdio: "inherit" });
if (!existsSync(path.join(root, tarball))) throw new Error(`npm pack did not produce ${tarball}`);
const project = mkdtempSync(path.join(tmpdir(), "briefwright-package-"));
execFileSync("npm", ["init", "-y"], { cwd: project, stdio: "ignore" });
execFileSync("npm", ["install", path.join(root, tarball), "--ignore-scripts"], { cwd: project, stdio: "inherit" });
const cli = path.join(project, "node_modules", ".bin", process.platform === "win32" ? "briefwright.cmd" : "briefwright");
const output = execFileSync(cli, ["--json", "capabilities"], { cwd: project, encoding: "utf8" });
const parsed = JSON.parse(output);
const cliVersion = execFileSync(cli, ["--version"], { cwd: project, encoding: "utf8" }).trim();
if (!parsed.ok || parsed.version !== packageVersion || cliVersion !== packageVersion || !parsed.formalRuns || !parsed.scheduling || !parsed.knowledgeWrites) {
  throw new Error("Packaged capability or version smoke test failed");
}
const listed = execFileSync("tar", ["-tf", path.join(root, tarball)], { encoding: "utf8" });
for (const required of ["package/README.md", "package/README.zh-CN.md", "package/policies/", "package/prompts/", "package/providers/", "package/schemas/", "package/skill/briefwright/SKILL.md"]) {
  if (!listed.includes(required)) throw new Error(`Package is missing ${required}`);
}
console.log(JSON.stringify({ ok: true, tarball, project, capabilities: parsed }, null, 2));
