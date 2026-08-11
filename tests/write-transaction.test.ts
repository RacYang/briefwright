import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { writeArtifactSetAtomic } from "../src/outputs/write.js";

describe("artifact transaction", () => {
  it("restores all prior artifacts when the durable commit fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-artifacts-"));
    const first = path.join(root, "daily.md");
    const second = path.join(root, "review.md");
    await writeFile(first, "old daily", "utf8");
    await writeFile(second, "old review", "utf8");
    await expect(writeArtifactSetAtomic(root, [{ path: first, content: "new daily" }, { path: second, content: "new review" }], () => { throw new Error("database failed"); })).rejects.toThrow("database failed");
    expect(await readFile(first, "utf8")).toBe("old daily");
    expect(await readFile(second, "utf8")).toBe("old review");
  });
});
