import { describe, expect, it } from "vitest";

import { detectedProviderId } from "../src/providers/detect.js";

describe("ordinary provider detection", () => {
  it("prefers an explicitly available API provider", () => {
    expect(detectedProviderId({ ANTHROPIC_API_KEY: "present" }, () => true)).toBe("anthropic");
    expect(detectedProviderId({ GEMINI_API_KEY: "present" }, () => true)).toBe("gemini");
    expect(detectedProviderId({ DASHSCOPE_API_KEY: "present" }, () => true)).toBe("qwen");
  });

  it("prefers an installed Codex account before local Ollama", () => {
    expect(detectedProviderId({}, (command) => command === "codex" || command === "ollama")).toBe("codex");
    expect(detectedProviderId({}, (command) => command === "ollama")).toBe("ollama");
  });

  it("uses Codex only as a visible initial choice when nothing is detected", () => {
    expect(detectedProviderId({}, () => false)).toBe("codex");
  });
});
