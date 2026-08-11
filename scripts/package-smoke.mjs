import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
execFileSync("npm", ["pack", "--ignore-scripts"], { cwd: root, stdio: "inherit" });
const tarball = readdirSync(root).filter((name) => /^briefwright-.*\.tgz$/.test(name)).sort().at(-1);
if (!tarball) throw new Error("npm pack did not produce a tarball");
const project = mkdtempSync(path.join(tmpdir(), "briefwright-package-"));
execFileSync("npm", ["init", "-y"], { cwd: project, stdio: "ignore" });
execFileSync("npm", ["install", path.join(root, tarball), "--ignore-scripts"], { cwd: project, stdio: "inherit" });
const cli = path.join(project, "node_modules", ".bin", process.platform === "win32" ? "briefwright.cmd" : "briefwright");
const output = execFileSync(cli, ["--json", "capabilities"], { cwd: project, encoding: "utf8" });
const parsed = JSON.parse(output);
if (!parsed.ok || !parsed.formalRuns || !parsed.scheduling || !parsed.knowledgeWrites) throw new Error("Packaged capability smoke test failed");
const listed = execFileSync("tar", ["-tf", path.join(root, tarball)], { encoding: "utf8" });
for (const required of ["package/policies/", "package/prompts/", "package/providers/", "package/schemas/", "package/skill/briefwright/SKILL.md"]) {
  if (!listed.includes(required)) throw new Error(`Package is missing ${required}`);
}
console.log(JSON.stringify({ ok: true, tarball, project, capabilities: parsed }, null, 2));
