import { describe, expect, it, vi } from "vitest";

import type { SourceDefinition } from "../src/config/types.js";
import { CodexBrowserConnector } from "../src/connectors/codex-browser.js";
import { ComputerUseConnector } from "../src/connectors/computer-use.js";
import { InAppBrowserConnector } from "../src/connectors/in-app-browser.js";
import { GithubReleasesConnector } from "../src/connectors/github-releases.js";
import { assertPublicAddress, assertPublicHttpsUrl, createHttpClient, readTextLimited } from "../src/connectors/http.js";
import { RssConnector } from "../src/connectors/rss.js";
import { WebpageConnector } from "../src/connectors/webpage.js";
import { retainExcerpt } from "../src/connectors/retention.js";
import type { ConnectorContext } from "../src/connectors/types.js";

function contextWith(response: Response): ConnectorContext {
  return {
    fetch: async () => response,
    now: () => new Date("2026-08-10T10:00:00Z"),
  };
}

describe("connector network boundary", () => {
  it("rejects non-HTTPS and literal private network targets", () => {
    expect(() => assertPublicHttpsUrl("http://example.com/feed")).toThrow("must use HTTPS");
    expect(() => assertPublicHttpsUrl("https://localhost/feed")).toThrow("localhost");
    expect(() => assertPublicHttpsUrl("https://127.0.0.1/feed")).toThrow("non-public");
    expect(() => assertPublicHttpsUrl("https://192.168.1.2/feed")).toThrow("non-public");
    expect(() => assertPublicHttpsUrl("https://localhost./feed")).toThrow("localhost");
    expect(() => assertPublicHttpsUrl("https://[::1]/feed")).toThrow("non-public");
    expect(() => assertPublicHttpsUrl("https://[fc00::1]/feed")).toThrow("non-public");
    expect(() => assertPublicHttpsUrl("https://[fe80::1]/feed")).toThrow("non-public");
    expect(() => assertPublicHttpsUrl("https://[::ffff:127.0.0.1]/feed")).toThrow("non-public");
    expect(() => assertPublicAddress("100.64.0.1")).toThrow("non-public");
    expect(() => assertPublicAddress("203.0.113.1")).toThrow("non-public");
    expect(() => assertPublicAddress("198.18.1.1")).toThrow("non-public");
    expect(() => assertPublicAddress("198.18.1.1", true)).not.toThrow();
    expect(assertPublicHttpsUrl("https://example.com/feed").hostname).toBe("example.com");
  });

  it("rejects response bodies larger than the declared runtime limit", async () => {
    await expect(readTextLimited(new Response("0123456789"), 5)).rejects.toThrow("exceeds");
  });

  it("follows a bounded same-host HTTPS redirect and closes gracefully", async () => {
    const dispatcher = {
      close: vi.fn(async () => {}),
      destroy: vi.fn(async () => {}),
    };
    const trackedPool = { close: vi.fn(async () => {}), destroy: vi.fn(async () => {}) };
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.redirect).toBe("manual");
      return String(input).endsWith("/research")
        ? new Response(null, { status: 308, headers: { location: "/research/" } })
        : new Response("ok", { status: 200 });
    });
    const client = createHttpClient(
      { timeoutSeconds: 1, retries: 0, allowedHosts: ["docs.ai21.com"] },
      { fetch: fetcher, dispatcher, fallbackDispatchers: [trackedPool], closeTimeoutMs: 10, destroyTimeoutMs: 50 },
    );

    await expect(client("https://docs.ai21.com/research")).resolves.toMatchObject({ status: 200 });
    const cleanup = await client.close();

    expect(cleanup).toMatchObject({ mode: "graceful" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(dispatcher.close).toHaveBeenCalledOnce();
    expect(dispatcher.destroy).not.toHaveBeenCalled();
    expect(trackedPool.destroy).not.toHaveBeenCalled();
  });

  it("rejects a redirect to another host even when that host belongs to another configured source", async () => {
    const dispatcher = { close: vi.fn(async () => {}), destroy: vi.fn(async () => {}) };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 302,
      headers: { location: "https://idp.example.net/authorize" },
    }));
    const client = createHttpClient(
      { timeoutSeconds: 1, retries: 0, allowedHosts: ["news.example.com", "idp.example.net"] },
      { fetch: fetcher, dispatcher },
    );

    await expect(client("https://news.example.com/latest")).rejects.toThrow("not the original source host");
    expect(await client.close()).toMatchObject({ mode: "forced" });
  });

  it("bounds graceful close and destroys tracked pools when Agent close never settles", async () => {
    const dispatcher = {
      close: vi.fn(() => new Promise<void>(() => {})),
      destroy: vi.fn(async () => {}),
    };
    const trackedPool = { close: vi.fn(async () => {}), destroy: vi.fn(async () => {}) };
    const client = createHttpClient(
      { timeoutSeconds: 1, retries: 0, allowedHosts: ["example.com"] },
      {
        fetch: vi.fn<typeof fetch>(async () => new Response("ok")),
        dispatcher,
        fallbackDispatchers: [trackedPool],
        closeTimeoutMs: 10,
        destroyTimeoutMs: 50,
      },
    );

    await expect(client("https://example.com/")).resolves.toMatchObject({ status: 200 });
    const cleanup = await Promise.race([
      client.close(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("cleanup exceeded test deadline")), 500)),
    ]);

    expect(cleanup).toMatchObject({ mode: "forced", detail: expect.stringContaining("exceeded 10ms") });
    expect(dispatcher.close).toHaveBeenCalledOnce();
    expect(trackedPool.destroy).toHaveBeenCalledOnce();
  });
});

describe("capture retention boundary", () => {
  it("retains at most 25 English or CJK words", () => {
    expect(retainExcerpt(Array.from({ length: 30 }, (_, index) => `word${index}`).join(" ")).split(" ")).toHaveLength(25);
    expect([...new Intl.Segmenter("zh", { granularity: "word" }).segment(retainExcerpt("这是一个用于验证版权留存边界的中文句子".repeat(10)))].filter((entry) => entry.isWordLike).length).toBeLessThanOrEqual(25);
  });

  it("hashes a bounded webpage body but persists only a 25-word excerpt and metadata", async () => {
    const text = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
    const response = new Response(`<html lang="en"><head><title>Example</title></head><body>${text}</body></html>`, {
      status: 200, headers: { "content-type": "text/html", etag: "v1", "last-modified": "Mon, 10 Aug 2026 00:00:00 GMT" },
    });
    const capture = (await new WebpageConnector().capture({ id: "WEB-TEST", title: "Web", evidenceTier: "primary", connector: { type: "webpage", config: { url: "https://example.com/news" } } }, contextWith(response)))[0]!;
    expect(capture.summary.split(" ")).toHaveLength(25);
    expect(capture.analysisText).toContain("word59");
    expect(capture).toMatchObject({ fetchStatus: "success", extractStatus: "success", httpStatus: 200, contentType: "text/html", language: "en", etag: "v1", parserVersion: "1.0.1" });
  });

  it("accepts bounded text/markdown responses used by public documentation sources", async () => {
    const response = new Response("# Release notes\n\nA production-ready model update.", {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
    const capture = (await new WebpageConnector().capture({
      id: "WEB-MARKDOWN",
      title: "Markdown docs",
      evidenceTier: "primary",
      connector: { type: "webpage", config: { url: "https://example.com/changelog.md" } },
    }, contextWith(response)))[0]!;

    expect(capture).toMatchObject({
      contentType: "text/markdown; charset=utf-8",
      title: "Markdown docs",
      parserVersion: "1.0.1",
    });
    expect(capture.analysisText).toContain("production-ready model update");
  });

  it("reports browser-backed sources as unverified until a current bundle is validated", async () => {
    const result = await new CodexBrowserConnector().check({
      id: "SRC-X-TEST",
      title: "X test",
      connector: { type: "codex-browser", config: { username: "OpenAI" } },
    });

    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining("not verified by doctor") });
  });

  it("reports Computer Use sources as unverified until a current bundle is validated", async () => {
    const result = await new ComputerUseConnector().check({
      id: "SRC-DYNAMIC",
      title: "Dynamic page",
      connector: { type: "computer-use", config: { url: "https://example.com/dynamic" } },
    });

    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining("not verified by doctor") });
  });

  it("reports isolated in-app Browser sources as unverified until a current bundle is validated", async () => {
    const result = await new InAppBrowserConnector().check({
      id: "SRC-DYNAMIC-BROWSER",
      title: "Dynamic page",
      connector: { type: "in-app-browser", config: { url: "https://example.com/dynamic" } },
    });
    expect(result).toMatchObject({ ok: false, detail: expect.stringContaining("isolated Browser capture bundle") });
  });
});

describe("built-in connectors", () => {
  it("checks GitHub availability through the public releases feed without consuming API quota", async () => {
    const connector = new GithubReleasesConnector();
    const fetcher = vi.fn(async () => new Response("<feed/>", { status: 200, headers: { "content-type": "application/atom+xml" } }));
    const result = await connector.check({ id: "GITHUB-CHECK", title: "GitHub", connector: { type: "github-releases", config: { repository: "acme/tool" } } },
      { fetch: fetcher, now: () => new Date("2026-08-10T10:00:00Z") });
    expect(result.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledWith("https://github.com/acme/tool/releases.atom", expect.objectContaining({ headers: expect.objectContaining({ accept: expect.stringContaining("application/atom+xml") }) }));
  });

  it("normalizes an RSS item into a primary capture envelope", async () => {
    const source: SourceDefinition = {
      id: "RSS-TEST",
      title: "RSS test",
      connector: { type: "rss", config: { url: "https://example.com/feed.xml" } },
    };
    const xml = `<?xml version="1.0"?><rss><channel><item>
      <title>Agent runtime update</title>
      <link>https://example.com/items/1</link>
      <guid>item-1</guid>
      <description><![CDATA[<p>A bounded update.</p>]]></description>
      <pubDate>Sun, 10 Aug 2026 09:00:00 GMT</pubDate>
    </item></channel></rss>`;
    const connector = new RssConnector();
    const captures = await connector.capture(
      source as SourceDefinition & { connector: { type: "rss"; config: { url: string } } },
      contextWith(new Response(xml, { status: 200 })),
    );

    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({
      sourceId: "RSS-TEST",
      externalKey: "item-1",
      canonicalUrl: "https://example.com/items/1",
      evidenceClass: "primary",
    });
    expect(captures[0]?.summary).toBe("A bounded update.");
  });

  it("keeps an RSS item with an invalid optional publication date without failing the source", async () => {
    const source: SourceDefinition = {
      id: "RSS-INVALID-DATE",
      title: "RSS invalid date",
      connector: { type: "rss", config: { url: "https://example.com/feed.xml" } },
    };
    const xml = `<rss><channel><item><title>Item</title><link>https://example.com/1</link><pubDate>not-a-date</pubDate></item></channel></rss>`;
    const captures = await new RssConnector().capture(
      source as SourceDefinition & { connector: { type: "rss"; config: { url: string } } },
      contextWith(new Response(xml, { status: 200 })),
    );
    expect(captures).toHaveLength(1);
    expect(captures[0]?.publishedAt).toBeUndefined();
  });

  it("normalizes arXiv-style object and numeric RSS identifiers with URL fallback", async () => {
    const source: SourceDefinition = {
      id: "SRC-ARXIV-CS-AI",
      title: "arXiv cs.AI",
      connector: { type: "rss", config: { url: "https://export.arxiv.org/rss/cs.AI" } },
    };
    const xml = `<rss><channel>
      <item><title>Object guid</title><link>https://arxiv.org/abs/2608.01234</link><guid isPermaLink="false">oai:arXiv.org:2608.01234v1</guid></item>
      <item><title>Numeric guid</title><link>https://arxiv.org/abs/2608.01235</link><guid>260801235</guid></item>
      <item><title>Attribute-only guid</title><link>https://arxiv.org/abs/2608.01236</link><guid isPermaLink="false"></guid></item>
    </channel></rss>`;
    const captures = await new RssConnector().capture(
      source as SourceDefinition & { connector: { type: "rss"; config: { url: string } } },
      contextWith(new Response(xml, { status: 200 })),
    );

    expect(captures.map((capture) => capture.externalKey)).toEqual([
      "oai:arXiv.org:2608.01234v1",
      "260801235",
      "https://arxiv.org/abs/2608.01236",
    ]);
    expect(captures.every((capture) => typeof capture.externalKey === "string" && capture.externalKey.length > 0)).toBe(true);
  });

  it("ignores draft and prerelease GitHub releases", async () => {
    const source: SourceDefinition = {
      id: "GITHUB-TEST",
      title: "GitHub test",
      connector: { type: "github-releases", config: { repository: "acme/tool" } },
    };
    const response = new Response(JSON.stringify([
      { id: 1, html_url: "https://github.com/acme/tool/releases/tag/v1", name: "Version 1", tag_name: "v1", body: "A stable release.", published_at: "2026-08-10T09:00:00Z", draft: false, prerelease: false },
      { id: 2, html_url: "https://github.com/acme/tool/releases/tag/v2-rc", name: "Version 2 RC", tag_name: "v2-rc", body: "Not stable.", published_at: "2026-08-10T09:30:00Z", draft: false, prerelease: true },
    ]), { status: 200, headers: { "content-type": "application/json" } });
    const connector = new GithubReleasesConnector();
    const captures = await connector.capture(
      source as SourceDefinition & {
        connector: { type: "github-releases"; config: { repository: string } };
      },
      contextWith(response),
    );

    expect(captures).toHaveLength(1);
    expect(captures[0]?.title).toBe("Version 1");
  });
});
