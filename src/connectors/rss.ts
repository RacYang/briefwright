import { createHash } from "node:crypto";

import { XMLParser } from "fast-xml-parser";

import type { SourceDefinition } from "../config/types.js";
import { assertPublicHttpsUrl, readTextLimited } from "./http.js";
import { retainExcerpt } from "./retention.js";
import type { CaptureEnvelope, Connector, ConnectorContext } from "./types.js";

type RssSource = SourceDefinition & {
  connector: { type: "rss"; config: { url: string } };
};

interface FeedItem {
  title?: string;
  link?: string | { "@_href"?: string; "@_rel"?: string } | Array<{ "@_href"?: string; "@_rel"?: string }>;
  guid?: string;
  id?: string;
  description?: string;
  summary?: string;
  pubDate?: string;
  published?: string;
  updated?: string;
}

function list<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function stripMarkup(value: string | undefined): string {
  const plain = (value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return retainExcerpt(plain);
}

function itemUrl(item: FeedItem): string | undefined {
  if (typeof item.link === "string") return item.link;
  const links = list(item.link);
  return (links.find((link) => link["@_rel"] === "alternate") ?? links[0])?.["@_href"];
}

export class RssConnector implements Connector<RssSource> {
  readonly descriptor = {
    type: "rss" as const,
    version: "1.0.0",
    title: "RSS and Atom",
    requiresCredentials: false,
    capabilities: ["capture", "conditional-fetch", "rss", "atom"],
    owner: "briefwright-core",
    riskLabels: ["untrusted-xml", "external-links"],
    configSchema: { type: "object", additionalProperties: false, required: ["url"], properties: { url: { type: "string", format: "uri", pattern: "^https://" } } },
    examples: [{ url: "https://example.com/feed.xml" }],
    authentication: { required: false, secretFields: [] },
  };

  async check(source: RssSource, context: ConnectorContext) {
    assertPublicHttpsUrl(source.connector.config.url);
    const response = await context.fetch(source.connector.config.url, {
      headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
    });
    const ok = response.ok; await response.body?.cancel();
    return ok
      ? { ok: true, detail: `${source.connector.config.url} is accessible` }
      : { ok: false, detail: `Feed returned HTTP ${response.status}` };
  }

  async capture(source: RssSource, context: ConnectorContext): Promise<CaptureEnvelope[]> {
    assertPublicHttpsUrl(source.connector.config.url);
    const response = await context.fetch(source.connector.config.url, {
      headers: {
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        ...(typeof context.cursor?.etag === "string" ? { "if-none-match": context.cursor.etag } : {}),
        ...(typeof context.cursor?.lastModified === "string" ? { "if-modified-since": context.cursor.lastModified } : {}),
      },
    });
    if (response.status === 304) {
      context.setCursor?.({ notModified: true });
      return [];
    }
    if (!response.ok) throw new Error(`Feed returned HTTP ${response.status}`);
    context.setCursor?.({
      ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
      ...(response.headers.get("last-modified") ? { lastModified: response.headers.get("last-modified")! } : {}),
    });
    const xml = await readTextLimited(response, 5 * 1024 * 1024);
    const parser = new XMLParser({ ignoreAttributes: false, trimValues: true, processEntities: false });
    const parsed = parser.parse(xml) as {
      rss?: { channel?: { item?: FeedItem | FeedItem[] } };
      feed?: { entry?: FeedItem | FeedItem[] };
    };
    const items = [
      ...list(parsed.rss?.channel?.item),
      ...list(parsed.feed?.entry),
    ];

    return items.slice(0, 20).flatMap((item) => {
      const rawUrl = itemUrl(item);
      const title = stripMarkup(item.title);
      if (!rawUrl || !title) return [];
      let url: string;
      try {
        url = assertPublicHttpsUrl(rawUrl).toString();
      } catch {
        return [];
      }
      const externalKey = item.guid ?? item.id ?? url;
      const content = `${title}\n${item.description ?? item.summary ?? ""}`;
      const analysisText = textContentForAnalysis(item.description ?? item.summary);
      const publishedAt = item.pubDate ?? item.published ?? item.updated;
      const publishedDate = publishedAt ? new Date(publishedAt) : null;
      const normalizedPublishedAt = publishedDate && Number.isFinite(publishedDate.getTime())
        ? publishedDate.toISOString()
        : undefined;
      return [{
        sourceId: source.id,
        externalKey,
        canonicalUrl: url,
        title,
        summary: stripMarkup(item.description ?? item.summary),
        capturedAt: context.now().toISOString(),
        ...(normalizedPublishedAt ? { publishedAt: normalizedPublishedAt } : {}),
        contentHash: createHash("sha256").update(content).digest("hex"),
        evidenceClass: source.evidenceTier === "clue" || source.evidenceTier === "secondary" ? "secondary" as const : "primary" as const,
        discoveryUrl: source.connector.config.url, discoveryChannel: "rss", fetchStatus: "success" as const,
        extractStatus: "success" as const, httpStatus: response.status, attempts: 1,
        contentType: response.headers.get("content-type") ?? "application/xml", ...(publishedAt ? { publishedRaw: publishedAt } : {}),
        ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
        ...(response.headers.get("last-modified") ? { lastModified: response.headers.get("last-modified")! } : {}),
        parserVersion: this.descriptor.version,
        analysisText,
      }];
    });
  }
}

function textContentForAnalysis(value: string | undefined): string {
  return (value ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().slice(0, 20_000);
}

export function isRssSource(source: SourceDefinition): source is RssSource {
  return source.connector.type === "rss";
}
