import { createHash } from "node:crypto";

import type { SourceDefinition } from "../config/types.js";
import { assertPublicHttpsUrl, readTextLimited } from "./http.js";
import { retainExcerpt } from "./retention.js";
import type { CaptureEnvelope, Connector, ConnectorContext } from "./types.js";

type WebpageSource = SourceDefinition & { connector: { type: "webpage"; config: { url: string } } };

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
}

export function extractReadableText(html: string): string {
  return decodeEntities(html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
}

function pageTitle(html: string, fallback: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return (title ? extractReadableText(title) : fallback).slice(0, 500);
}

export class WebpageConnector implements Connector<WebpageSource> {
  readonly descriptor = {
    type: "webpage", version: "1.0.1", title: "Bounded public webpage", requiresCredentials: false,
    capabilities: ["capture", "conditional-fetch", "html", "markdown"], owner: "briefwright-core",
    riskLabels: ["untrusted-html", "prompt-injection", "dynamic-page-limitations"],
    configSchema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", format: "uri", pattern: "^https://" } } },
    examples: [{ url: "https://example.com/news" }], authentication: { required: false, secretFields: [] },
  };

  async check(source: WebpageSource, context: ConnectorContext) {
    assertPublicHttpsUrl(source.connector.config.url);
    const response = await context.fetch(source.connector.config.url, { method: "GET", headers: { accept: "text/html,application/xhtml+xml,text/markdown,text/plain" } });
    const ok = response.ok; await response.body?.cancel();
    return ok
      ? { ok: true, detail: `${source.connector.config.url} is accessible` }
      : { ok: false, detail: `Webpage returned HTTP ${response.status}` };
  }

  async capture(source: WebpageSource, context: ConnectorContext): Promise<CaptureEnvelope[]> {
    const url = assertPublicHttpsUrl(source.connector.config.url);
    const response = await context.fetch(url.toString(), { headers: {
      accept: "text/html,application/xhtml+xml,text/markdown,text/plain",
      ...(typeof context.cursor?.etag === "string" ? { "if-none-match": context.cursor.etag } : {}),
      ...(typeof context.cursor?.lastModified === "string" ? { "if-modified-since": context.cursor.lastModified } : {}),
    } });
    if (response.status === 304) { context.setCursor?.({ notModified: true }); return []; }
    if (!response.ok) throw new Error(`Webpage returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!/(?:text\/html|application\/xhtml\+xml|text\/(?:plain|markdown))/i.test(contentType)) throw new Error(`Unsupported webpage content type: ${contentType || "missing"}`);
    context.setCursor?.({
      ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
      ...(response.headers.get("last-modified") ? { lastModified: response.headers.get("last-modified")! } : {}),
    });
    const html = await readTextLimited(response, 5 * 1024 * 1024);
    const normalizedText = extractReadableText(html);
    if (!normalizedText) throw new Error("Webpage produced no readable text");
    const contentHash = createHash("sha256").update(normalizedText).digest("hex");
    const analysisText = normalizedText.slice(0, 20_000);
    const language = /<html[^>]+lang=["']?([^"'\s>]+)/i.exec(html)?.[1] ?? response.headers.get("content-language") ?? undefined;
    return [{
      sourceId: source.id, externalKey: url.toString(), canonicalUrl: url.toString(),
      title: pageTitle(html, source.title), summary: retainExcerpt(normalizedText), capturedAt: context.now().toISOString(),
      contentHash, evidenceClass: source.evidenceTier === "primary" ? "primary" : "secondary",
      discoveryUrl: url.toString(), discoveryChannel: "webpage", fetchStatus: "success", extractStatus: "success",
      httpStatus: response.status, attempts: 1, contentType, ...(language ? { language } : {}),
      ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
      ...(response.headers.get("last-modified") ? { lastModified: response.headers.get("last-modified")! } : {}),
      parserVersion: this.descriptor.version,
      analysisText,
    }];
  }
}

export function isWebpageSource(source: SourceDefinition): source is WebpageSource {
  return source.connector.type === "webpage";
}
