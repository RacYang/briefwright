import { Ajv2020 } from "ajv/dist/2020.js";

import type { PromptPackDefinition } from "../config/types.js";
import type { ModelAnalysis } from "./types.js";

export function validateModelAnalysis(value: unknown, prompt: PromptPackDefinition, domains: string[]): ModelAnalysis {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(prompt.outputSchema);
  if (!validate(value)) {
    const detail = (validate.errors ?? []).slice(0, 8).map((item) => `${item.instancePath || "/"} ${item.message}`).join("; ");
    throw new Error(`Model analysis did not satisfy the output contract: ${detail}`);
  }
  const result = value as ModelAnalysis;
  if (!domains.includes(result.domain)) throw new Error(`Model returned unsupported domain: ${result.domain}`);
  return result;
}
