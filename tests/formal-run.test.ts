import { mkdir, mkdtemp, readFile, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/commands/init.js";
import { runFormalProject } from "../src/core/run.js";
import { verifyReplay } from "../src/commands/replay.js";
import { FixtureModelProvider } from "../src/providers/fixture.js";

function sourceResponse(url: string): Response {
  if (url.includes("api.github.com")) {
    return new Response(JSON.stringify([{
      id: 10,
      html_url: "https://github.com/QwenLM/qwen-code/releases/tag/v1.2.3",
      name: "Agent runtime v1.2.3",
      tag_name: "v1.2.3",
      body: "AI agents gain an explicit tool budget and evidence checkpoint.",
      published_at: "2026-08-11T00:00:00Z",
      draft: false,
      prerelease: false,
    }]), { status: 200, headers: { etag: '"github-v1"' } });
  }
  return new Response(`<rss><channel><item>
    <title>AI agent evaluation protocol</title>
    <link>https://arxiv.org/abs/2608.00001</link>
    <guid>2608.00001</guid>
    <description>AI agents are evaluated with bounded evidence.</description>
    <pubDate>Tue, 11 Aug 2026 00:00:00 GMT</pubDate>
  </item></channel></rss>`, { status: 200, headers: { etag: '"rss-v1"' } });
}

describe("formal run", () => {
  it("freezes, captures, analyzes, selects, publishes, and is idempotent within the day", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-formal-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    const now = new Date("2026-08-11T02:00:00Z");
    let fetchCount = 0;
    const first = await runFormalProject(configPath, {
      now,
      provider: new FixtureModelProvider(),
      fetch: async (url) => { fetchCount += 1; return sourceResponse(String(url)); },
    });
    expect(first.runId).toBe("RUN-20260811-DAILY");
    expect(first.alreadyComplete).toBe(false);
    expect(first.outcome).toBe("success");
    expect(first.result.receipts).toHaveLength(8);
    expect(first.result.daily.length).toBeGreaterThan(0);
    expect(await readFile(first.dailyPath, "utf8")).toContain("RULE-WORKFLOW-V1.3");
    expect(await readFile(first.reviewPath, "utf8")).toContain("queue was not padded");
    expect(await readFile(path.join(path.dirname(first.dailyPath), "index.md"), "utf8")).toContain("<!-- briefwright:index:start -->");
    await expect(verifyReplay(configPath, first.runId)).resolves.toMatchObject({
      matches: true,
      artifacts: [{ kind: "daily-markdown" }, { kind: "review-markdown" }],
    });

    const second = await runFormalProject(configPath, {
      now,
      provider: new FixtureModelProvider(),
      fetch: async () => { throw new Error("idempotent rerun must not fetch"); },
    });
    expect(second.alreadyComplete).toBe(true);
    expect(fetchCount).toBe(8);
  }, 20_000);

  it("resumes an interrupted run from durable receipts without fetching sources again", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-resume-"));
    const outside = await mkdtemp(path.join(tmpdir(), "briefwright-resume-outside-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    await symlink(outside, path.join(root, "briefs"));
    const now = new Date("2026-08-12T02:00:00Z");
    await expect(runFormalProject(configPath, { now, provider: new FixtureModelProvider(), fetch: async (url) => sourceResponse(String(url)) })).rejects.toThrow("symlink");
    await unlink(path.join(root, "briefs"));
    await mkdir(path.join(root, "briefs"));
    const resumed = await runFormalProject(configPath, { now, provider: new FixtureModelProvider(), fetch: async () => { throw new Error("resume unexpectedly fetched"); } });
    expect(resumed.resumed).toBe(true);
    expect(resumed.outcome).toBe("success");
    expect(resumed.result.receipts).toHaveLength(8);
  }, 20_000);
});
