import { accessSync, constants } from "node:fs";
import path from "node:path";

function systemCommandAvailable(command: string): boolean {
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const suffixes = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      try {
        accessSync(path.join(directory, `${command}${suffix}`), constants.X_OK);
        return true;
      } catch {
        // Continue looking without executing anything found on PATH.
      }
    }
  }
  return false;
}

export function detectedProviderId(
  environment: NodeJS.ProcessEnv = process.env,
  commandAvailable: (command: string) => boolean = systemCommandAvailable,
): "codex" | "openai" | "anthropic" | "gemini" | "qwen" | "ollama" {
  if (environment.OPENAI_API_KEY) return "openai";
  if (environment.ANTHROPIC_API_KEY) return "anthropic";
  if (environment.GEMINI_API_KEY || environment.GOOGLE_API_KEY) return "gemini";
  if (environment.DASHSCOPE_API_KEY) return "qwen";
  if (commandAvailable("codex")) return "codex";
  if (commandAvailable("ollama")) return "ollama";
  return "codex";
}
