import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";

import { ejectConfiguration } from "../src/commands/config.js";
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
    const dailyArtifact = await readFile(first.dailyPath, "utf8");
    expect(dailyArtifact).toContain("RULE-WORKFLOW-V1.3");
    expect(dailyArtifact).toContain("source_manifest_digest:");
    expect(dailyArtifact).toContain("## Stage timings before publish");
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
  }, 60_000);

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
  }, 60_000);

  it("records model failures as a partial terminal outcome in both artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-model-failure-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    const failed = await runFormalProject(configPath, {
      now: new Date("2026-08-13T02:00:00Z"),
      provider: {
        id: "failure-fixture",
        version: "1.0.0",
        async check() { return { ok: false, detail: "fixture" }; },
        async analyze() { throw new Error("model unavailable"); },
      },
      fetch: async (url) => sourceResponse(String(url)),
    });
    expect(failed.outcome).toBe("partial");
    expect(failed.result.outcome).toBe("partial");
    expect(failed.result.modelFailures?.length).toBeGreaterThan(0);
    expect(await readFile(failed.dailyPath, "utf8")).toContain("status: partial");
    expect(await readFile(failed.reviewPath, "utf8")).toContain("- Outcome: partial");
    const recovered = await runFormalProject(configPath, {
      now: new Date("2026-08-13T04:00:00Z"),
      retryFailed: true,
      provider: new FixtureModelProvider(),
      fetch: async () => { throw new Error("model-only recovery must not refetch successful sources"); },
    });
    expect(recovered.runId).toBe("RUN-20260813-DAILY-R01");
    expect(recovered.result.runKind).toBe("formal-retry");
    expect(recovered.outcome).toBe("success");
    expect(recovered.result.daily.length).toBeGreaterThan(0);
    await expect(runFormalProject(configPath, { now: new Date("2026-08-13T05:00:00Z"), retryFailed: true, provider: new FixtureModelProvider() })).rejects.toThrow("no failed operations");
  }, 60_000);

  it("reports capture-limit backlog as partial and makes it recoverable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-backlog-"));
    const configPath = await initializeProject({ directory: root, yes: true, interests: ["AI agents"] });
    await ejectConfiguration(configPath);
    const profilePath = path.join(root, "briefwright.d/profile.yaml");
    const profile = parse(await readFile(profilePath, "utf8")) as { spec: { runtime: { maximumCapturesPerRun: number } } };
    profile.spec.runtime.maximumCapturesPerRun = 1;
    await writeFile(profilePath, stringify(profile), "utf8");
    const first = await runFormalProject(configPath, {
      now: new Date("2026-08-14T02:00:00Z"),
      provider: new FixtureModelProvider(),
      fetch: async (url) => sourceResponse(String(url)),
    });
    expect(first.outcome).toBe("partial");
    expect(first.result.modelFailures).toContainEqual(expect.objectContaining({ detail: expect.stringContaining("deferred") }));
    const recovery = await runFormalProject(configPath, {
      now: new Date("2026-08-14T03:00:00Z"),
      retryFailed: true,
      provider: new FixtureModelProvider(),
      fetch: async () => { throw new Error("analysis backlog recovery must not refetch"); },
    });
    expect(recovery.runId).toBe("RUN-20260814-DAILY-R01");
    expect(recovery.outcome).toBe("partial");
  }, 60_000);
});
