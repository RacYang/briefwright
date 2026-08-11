import { createHash } from "node:crypto";

import type { SourceDefinition } from "../config/types.js";
import { resolveSecret } from "../config/secrets.js";
import { readJsonLimited } from "./http.js";
import { retainExcerpt } from "./retention.js";
import type { CaptureEnvelope, Connector, ConnectorContext } from "./types.js";

type XSource = SourceDefinition & { connector: { type: "x-api"; config: { username: string; bearerToken: { provider: "env" | "file"; key: string } } } };
export function isXSource(source: SourceDefinition): source is XSource { return source.connector.type === "x-api"; }

export class XApiConnector implements Connector<XSource> {
  readonly descriptor = { type: "x-api", version: "1.0.0", title: "X API v2 user timeline", requiresCredentials: true,
    capabilities: ["incremental", "conditional-cursor", "clue-only"], owner: "briefwright", riskLabels: ["credentialed", "rate-limited"],
    configSchema: { type: "object", required: ["username", "bearerToken"] }, examples: [{ username: "OpenAI", bearerToken: { provider: "env", key: "X_BEARER_TOKEN" } }],
    authentication: { required: true, secretFields: ["bearerToken"] } };
  private async token(source: XSource, context: ConnectorContext): Promise<string> {
    if (!context.projectRoot) throw new Error("X connector requires the project root for secret resolution");
    return resolveSecret(source.connector.config.bearerToken, context.projectRoot);
  }
  async check(source: XSource, context: ConnectorContext) { try { await this.user(source, context); return { ok: true, detail: `X user @${source.connector.config.username} is accessible` }; } catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) }; } }
  private async user(source: XSource, context: ConnectorContext): Promise<{ id: string }> {
    const token = await this.token(source, context); const response = await context.fetch(`https://api.x.com/2/users/by/username/${encodeURIComponent(source.connector.config.username)}`, { headers: { authorization: `Bearer ${token}` } });
    const payload = await readJsonLimited<{ data?: { id?: string }; detail?: string }>(response, 512_000);
    if (!response.ok || !payload.data?.id) throw new Error(`X user lookup failed: ${payload.detail ?? `HTTP ${response.status}`}`); return { id: payload.data.id };
  }
  async capture(source: XSource, context: ConnectorContext): Promise<CaptureEnvelope[]> {
    const token = await this.token(source, context); const user = await this.user(source, context);
    const sinceId = typeof context.cursor?.sinceId === "string" ? context.cursor.sinceId : undefined;
    const url = new URL(`https://api.x.com/2/users/${user.id}/tweets`); url.searchParams.set("max_results", "100"); url.searchParams.set("tweet.fields", "created_at,entities,referenced_tweets"); if (sinceId) url.searchParams.set("since_id", sinceId);
    const response = await context.fetch(url.toString(), { headers: { authorization: `Bearer ${token}` } });
    const payload = await readJsonLimited<{ data?: Array<{ id: string; text: string; created_at?: string }>; detail?: string }>(response, 2_000_000);
    if (!response.ok) throw new Error(`X timeline failed: ${payload.detail ?? `HTTP ${response.status}`}`);
    const tweets = payload.data ?? []; const newest = tweets.map((tweet) => tweet.id).sort((a, b) => BigInt(a) > BigInt(b) ? -1 : 1)[0]; if (newest) context.setCursor?.({ sinceId: newest });
    return tweets.map((tweet) => ({ sourceId: source.id, externalKey: tweet.id, canonicalUrl: `https://x.com/${source.connector.config.username}/status/${tweet.id}`,
      title: retainExcerpt(tweet.text, 12).slice(0, 180), summary: retainExcerpt(tweet.text), capturedAt: context.now().toISOString(), ...(tweet.created_at ? { publishedAt: new Date(tweet.created_at).toISOString(), publishedRaw: tweet.created_at } : {}),
      contentHash: createHash("sha256").update(tweet.text).digest("hex"), evidenceClass: "secondary" as const,
      discoveryUrl: url.toString(), discoveryChannel: "x-api", fetchStatus: "success" as const, extractStatus: "success" as const,
      httpStatus: response.status, attempts: 1, contentType: response.headers.get("content-type") ?? "application/json",
      author: `@${source.connector.config.username}`, parserVersion: this.descriptor.version, analysisText: tweet.text }));
  }
}
