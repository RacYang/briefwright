import { describe, expect, it } from "vitest";

import { updateBriefingIndex, validateBriefingIndex } from "../src/outputs/index.js";

describe("managed briefing indexes", () => {
  it("uses portable forward-slash Wiki targets for Windows paths", () => {
    const content = updateBriefingIndex(undefined, "Daily", "Daily\\2026-08-11-AI情报简报.md", "ai-intelligence-digest");
    expect(content).toContain("[[Daily/2026-08-11-AI情报简报|Daily/2026-08-11-AI情报简报]]");
    expect(() => validateBriefingIndex(content, "Daily\\2026-08-11-AI情报简报.md", "ai-intelligence-digest")).not.toThrow();
  });
});
