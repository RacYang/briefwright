import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runDemo } from "../src/commands/demo.js";

describe("offline demo", () => {
  it("produces a clearly marked source-linked briefing without credentials", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-demo-"));
    const configPath = path.join(root, "briefing.yaml");
    await writeFile(configPath, "user-owned", "utf8");
    const result = await runDemo(root);
    const markdown = await readFile(result.outputPath, "utf8");

    expect(result.itemCount).toBeGreaterThan(0);
    expect(result.receiptCount).toBe(8);
    expect(markdown).toContain("data_mode: fixture");
    expect(markdown).toContain("Demonstration data");
    expect(markdown).toContain("Due sources: 8");
    expect(markdown).toContain("Missing: 0");
    expect(await readFile(configPath, "utf8")).toBe("user-owned");
    const second = await runDemo(root);
    expect(second.outputPath).not.toBe(result.outputPath);
    await expect(access(result.outputPath)).resolves.toBeUndefined();
  });
});
