import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import * as p from "@clack/prompts";
import { stringify } from "yaml";

import type { BriefingIntent } from "../config/types.js";
import { detectedProviderId } from "../providers/detect.js";

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export interface InitOptions {
  directory: string;
  yes: boolean;
  name?: string;
  interests?: string[];
  model?: BriefingIntent["model"];
  processStore?: BriefingIntent["processStore"];
  documentStore?: BriefingIntent["documentStore"];
  schedule?: BriefingIntent["schedule"];
}

export async function initializeProject(options: InitOptions): Promise<string> {
  const root = path.resolve(options.directory);
  const configPath = path.join(root, "briefing.yaml");

  if (await exists(configPath)) {
    throw new Error(`briefing.yaml already exists at ${configPath}; no files were changed`);
  }

  let name = options.name ?? "My AI briefing";
  let interests = options.interests ?? ["AI agents", "model releases", "AI safety"];

  if (!options.yes && process.stdin.isTTY) {
    p.intro("Create a Briefwright project");
    const answers = await p.group(
      {
        name: () => p.text({
          message: "What should this briefing be called?",
          placeholder: name,
          defaultValue: name,
        }),
        interests: () => p.text({
          message: "What should it watch? Use commas between topics.",
          placeholder: interests.join(", "),
          defaultValue: interests.join(", "),
        }),
      },
      {
        onCancel: () => {
          p.cancel("Initialization cancelled; no files were changed.");
          throw new Error("Initialization cancelled; no files were changed");
        },
      },
    );
    if (p.isCancel(answers.name) || p.isCancel(answers.interests)) {
      throw new Error("Initialization cancelled; no files were changed");
    }
    name = answers.name.trim();
    interests = answers.interests.split(",").map((item) => item.trim()).filter(Boolean);
  }

  const intent: BriefingIntent = {
    version: 3,
    name,
    preset: "ai-daily",
    interests,
    schedule: options.schedule ?? "manual",
    output: "markdown",
    outputDirectory: "briefs",
    model: options.model ?? detectedProviderId(),
    processStore: options.processStore ?? "auto",
    documentStore: options.documentStore ?? "auto",
  };

  await mkdir(root, { recursive: true });
  await writeFile(configPath, stringify(intent), { encoding: "utf8", flag: "wx" });
  return configPath;
}
