import * as p from "@clack/prompts";

import type { BriefingIntent } from "../config/types.js";
import { initializeProject } from "./init.js";

export interface SetupOptions {
  directory: string;
  yes: boolean;
  name?: string;
  interests?: string[];
  model?: string;
  processStore?: "lark" | "postgres" | "mysql" | "sqlite";
  larkBase?: string;
  connectionEnv?: string;
  documentStore?: "obsidian" | "local";
  documentRoot?: string;
  schedule?: BriefingIntent["schedule"];
}

function detectedModel(): string {
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return "gemini";
  if (process.env.DASHSCOPE_API_KEY) return "qwen";
  return "ollama";
}

export async function setupProject(options: SetupOptions): Promise<{ configPath: string; choices: Record<string, unknown>; next: string[] }> {
  let name = options.name ?? "My AI briefing"; let interests = options.interests ?? ["AI agents", "model releases", "AI safety"];
  let model = options.model ?? detectedModel(); let processStore = options.processStore ?? (process.env.BRIEFWRIGHT_LARK_BASE_TOKEN ? "lark" : "sqlite");
  let documentStore = options.documentStore ?? "local"; let schedule = options.schedule ?? "manual";
  let larkBase = options.larkBase ?? process.env.BRIEFWRIGHT_LARK_BASE_TOKEN; let connectionEnv = options.connectionEnv; let documentRoot = options.documentRoot;
  if (!options.yes && process.stdin.isTTY) {
    p.intro("Set up Briefwright");
    const answers = await p.group({
      name: () => p.text({ message: "What should this briefing be called?", defaultValue: name }),
      interests: () => p.text({ message: "What should it watch? Use commas.", defaultValue: interests.join(", ") }),
      model: () => p.select({ message: "Which model provider should analyze captures?", initialValue: model, options: [
        { value: "codex", label: "Codex account (no API key inside a Codex task)" },
        { value: "openai", label: "OpenAI" }, { value: "anthropic", label: "Anthropic" }, { value: "gemini", label: "Google Gemini" },
        { value: "qwen", label: "Alibaba Qwen" }, { value: "ollama", label: "Ollama (local)" },
      ] }),
      processStore: () => p.select({ message: "Where should process data live?", initialValue: processStore, options: [
        { value: "lark", label: "Feishu Base via lark-cli (recommended for teams)" }, { value: "sqlite", label: "SQLite (zero configuration)" },
        { value: "postgres", label: "PostgreSQL" }, { value: "mysql", label: "MySQL" },
      ] }),
      documentStore: () => p.select({ message: "Where should Markdown briefings live?", initialValue: documentStore, options: [
        { value: "obsidian", label: "Obsidian vault (recommended)" }, { value: "local", label: "Local project folder" },
      ] }),
      schedule: () => p.select({ message: "Schedule now? You can keep this manual until preview succeeds.", initialValue: schedule, options: [
        { value: "manual", label: "Manual for now" }, { value: "daily-at-10", label: "Daily at 10:00" }, { value: "weekdays-at-09", label: "Weekdays at 09:00" },
      ] }),
    }, { onCancel: () => { p.cancel("Setup cancelled; no files were changed."); throw new Error("Setup cancelled; no files were changed"); } });
    name = String(answers.name).trim(); interests = String(answers.interests).split(",").map((item) => item.trim()).filter(Boolean);
    model = String(answers.model); processStore = answers.processStore as typeof processStore; documentStore = answers.documentStore as typeof documentStore; schedule = answers.schedule as typeof schedule;
    if (processStore === "lark" && !larkBase) {
      const value = await p.text({ message: "Feishu Base app token (lark-cli supplies your identity):", placeholder: "bascn... or Base app token" });
      if (p.isCancel(value)) throw new Error("Setup cancelled; no files were changed"); larkBase = value.trim();
    }
    if ((processStore === "postgres" || processStore === "mysql") && !connectionEnv) {
      const value = await p.text({ message: `Environment variable containing the ${processStore} connection URL:`, placeholder: processStore === "postgres" ? "BRIEFWRIGHT_POSTGRES_URL" : "BRIEFWRIGHT_MYSQL_URL" });
      if (p.isCancel(value)) throw new Error("Setup cancelled; no files were changed"); connectionEnv = value.trim();
    }
    if (documentStore === "obsidian" && !documentRoot) {
      const value = await p.text({ message: "Absolute path to the Obsidian vault:", placeholder: "/Users/me/Documents/My Vault" });
      if (p.isCancel(value)) throw new Error("Setup cancelled; no files were changed"); documentRoot = value.trim();
    }
    p.note([
      `Model: ${model}`,
      `Process store: ${processStore}`,
      `Documents: ${documentStore}${documentRoot ? ` (${documentRoot})` : ""}`,
      `Schedule intent: ${schedule} (not installed by setup)`,
    ].join("\n"), "Review the local project plan");
    const confirmed = await p.confirm({ message: "Write briefing.yaml with this plan?", initialValue: true });
    if (p.isCancel(confirmed) || !confirmed) { p.cancel("Setup cancelled; no files were changed."); throw new Error("Setup cancelled; no files were changed"); }
  }
  if (processStore === "lark" && !larkBase) throw new Error("Lark setup needs --lark-base <Base token or app token>. Briefwright never guesses a Base.");
  if ((processStore === "postgres" || processStore === "mysql") && !connectionEnv) throw new Error(`${processStore} setup needs --connection-env <ENV_NAME>`);
  if (documentStore === "obsidian" && !documentRoot) throw new Error("Obsidian setup needs --document-root <vault path>");
  const processIntent: BriefingIntent["processStore"] = processStore === "lark" ? { driver: "lark", baseToken: larkBase!, identity: "user" }
    : processStore === "postgres" || processStore === "mysql" ? { driver: processStore, connection: { provider: "env", key: connectionEnv! } } : "sqlite";
  const documentIntent: BriefingIntent["documentStore"] = documentStore === "obsidian" ? { driver: "obsidian", root: documentRoot!, briefingDirectory: "Inbox/AI Intelligence" } : "local";
  const configPath = await initializeProject({ directory: options.directory, yes: true, name, interests, model, processStore: processIntent, documentStore: documentIntent, schedule });
  return { configPath, choices: { model, processStore, documentStore, schedule }, next: [
    ...(processStore === "lark" ? [`briefwright lark provision --yes --config ${configPath}`] : []),
    ...(processStore === "postgres" || processStore === "mysql" ? [`briefwright sql provision --yes --config ${configPath}`] : []),
    `briefwright doctor --config ${configPath}`, `briefwright preview --config ${configPath}`, `briefwright preview --live --config ${configPath}`,
    `briefwright doctor --online --config ${configPath}`, `briefwright run --config ${configPath}`,
    ...(schedule === "manual" ? [] : [`briefwright schedule enable --yes --config ${configPath}`]),
  ] };
}
