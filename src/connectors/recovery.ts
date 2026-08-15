import { createHash } from "node:crypto";

import type { SourceDefinition } from "../config/types.js";
import { assertPublicHttpsUrl, readTextLimited } from "./http.js";
import { retainExcerpt } from "./retention.js";
import type { CaptureEnvelope, ConnectorContext } from "./types.js";
import { extractReadableText } from "./webpage.js";

function hostname(value: string): string {
  return value.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

function sameDomain(left: string, right: string): boolean {
  const a = hostname(left); const b = hostname(right);
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

export function canonicalRecoveryHost(source: SourceDefinition, capture: CaptureEnvelope): string {
  if (capture.sourceId !== source.id) throw new Error("Canonical recovery target does not belong to the active source");
  const target = assertPublicHttpsUrl(capture.canonicalUrl);
  if (source.connector.type === "github-releases") {
    const repository = source.connector.config.repository.toLowerCase();
    if (hostname(target.hostname) !== "github.com" || !target.pathname.toLowerCase().startsWith(`/${repository}/`)) {
      throw new Error("GitHub canonical recovery target is outside the configured repository");
    }
    return target.hostname;
  }
  if (source.connector.type === "rss" || source.connector.type === "webpage") {
    const configured = assertPublicHttpsUrl(source.connector.config.url);
    const permitted = source.connector.type === "rss"
      ? sameDomain(configured.hostname, target.hostname)
      : hostname(configured.hostname) === hostname(target.hostname);
    if (!permitted) throw new Error("Canonical recovery target is outside the configured source domain");
    return target.hostname;
  }
  if (source.connector.type === "extension") {
    const allowed = source.connector.config.options.allowedHosts;
    if (!Array.isArray(allowed) || !allowed.some((host) => typeof host === "string" && hostname(host) === hostname(target.hostname))) {
      throw new Error("Canonical recovery target is outside the extension host allowlist");
    }
    return target.hostname;
  }
  throw new Error(`Connector ${source.connector.type} does not permit direct canonical evidence recovery`);
}

export async function recoverCanonicalEvidence(
  source: SourceDefinition,
  capture: CaptureEnvelope,
  fetch: ConnectorContext["fetch"],
  now: () => Date = () => new Date(),
): Promise<CaptureEnvelope> {
  canonicalRecoveryHost(source, capture);
  const response = await fetch(capture.canonicalUrl, { headers: { accept: "text/html,application/xhtml+xml,text/plain" } });
  if (!response.ok) throw new Error(`Canonical source returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!/(?:text\/html|application\/xhtml\+xml|text\/plain)/i.test(contentType)) throw new Error(`Unsupported canonical source content type: ${contentType || "missing"}`);
  const body = await readTextLimited(response, 5 * 1024 * 1024);
  const text = /(?:text\/html|application\/xhtml\+xml)/i.test(contentType) ? extractReadableText(body) : body.replace(/\s+/gu, " ").trim();
  if (!text) throw new Error("Canonical source produced no readable evidence");
  const contentHash = createHash("sha256").update(text).digest("hex");
  return {
    ...capture,
    summary: retainExcerpt(text),
    capturedAt: now().toISOString(),
    contentHash,
    recoveryOfContentHash: capture.contentHash,
    discoveryUrl: capture.canonicalUrl,
    discoveryChannel: "canonical-recovery",
    fetchStatus: "success",
    extractStatus: "success",
    httpStatus: response.status,
    attempts: 1,
    contentType,
    parserVersion: "canonical-recovery-v2",
    analysisText: text.slice(0, 20_000),
  };
}
