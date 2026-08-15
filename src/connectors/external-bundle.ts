import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { EffectiveConfig, SourceDefinition } from "../config/types.js";
import { assertSafeReadPath } from "../config/paths.js";
import { computerUseAllowedHosts, isComputerUseSource, type ComputerUseSource } from "./computer-use.js";
import { isCodexBrowserSource, type CodexBrowserSource } from "./codex-browser.js";
import { inAppBrowserAllowedHosts, isInAppBrowserSource, type InAppBrowserSource } from "./in-app-browser.js";
import type { CaptureEnvelope } from "./types.js";

export interface ExternalCaptureResult {
  sourceId: string;
  status: "captured" | "unchanged" | "failed";
  captureMode?: "codex-browser" | "in-app-browser" | "computer-use";
  captures?: Array<{
    url: string;
    title: string;
    text: string;
    publishedAt?: string;
    dateKind?: "event" | "page-updated";
    author?: string;
  }>;
  detail?: string;
}

export interface ExternalCaptureBundle {
  apiVersion: "briefwright.dev/external-captures/v1";
  generatedAt: string;
  sources: ExternalCaptureResult[];
}

export interface ValidatedExternalCapture {
  sourceId: string;
  status: ExternalCaptureResult["status"];
  captures: CaptureEnvelope[];
  detail?: string;
}

type ExternalCaptureSource = CodexBrowserSource | InAppBrowserSource | ComputerUseSource;

export function isExternalCaptureSource(source: SourceDefinition): source is ExternalCaptureSource {
  return source.connector.type === "codex-browser" || source.connector.type === "in-app-browser" || source.connector.type === "computer-use";
}

function string(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /\0/.test(value)) {
    throw new Error(`${field} must be a non-empty string up to ${maximum} characters`);
  }
  return value.trim();
}

function computerUseUrl(source: ComputerUseSource, raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`Capture URL is invalid for ${source.id}`); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(`Capture URL must be clean HTTPS for ${source.id}`);
  const allowed = computerUseAllowedHosts(source);
  if (!allowed.includes(url.hostname.toLowerCase())) {
    throw new Error(`Capture URL host ${url.hostname} is not allowed for ${source.id}; expected ${allowed.join(", ")}`);
  }
  url.hash = "";
  return url;
}

function inAppBrowserUrl(source: InAppBrowserSource, raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`Capture URL is invalid for ${source.id}`); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(`Capture URL must be clean HTTPS for ${source.id}`);
  const allowed = inAppBrowserAllowedHosts(source);
  if (!allowed.includes(url.hostname.toLowerCase())) {
    throw new Error(`Capture URL host ${url.hostname} is not allowed for ${source.id}; expected ${allowed.join(", ")}`);
  }
  url.hash = "";
  return url;
}

function normalizeXCapture(
  source: CodexBrowserSource,
  capture: NonNullable<ExternalCaptureResult["captures"]>[number],
  generatedAt: Date,
  now: Date,
  seen: Set<string>,
): CaptureEnvelope {
  const url = string(capture.url, "capture.url", 1_000);
  const match = /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:\?.*)?$/.exec(url);
  if (!match || match[1]!.toLowerCase() !== source.connector.config.username.toLowerCase()) {
    throw new Error(`Capture URL does not match @${source.connector.config.username} for ${source.id}`);
  }
  if (seen.has(match[2]!)) throw new Error(`External capture bundle repeats status ${match[2]}`);
  seen.add(match[2]!);
  const text = string(capture.text, "capture.text", 10_000);
  const title = string(capture.title, "capture.title", 500);
  const publishedAt = capture.publishedAt === undefined ? undefined : new Date(string(capture.publishedAt, "capture.publishedAt", 80));
  if (capture.dateKind !== undefined && capture.dateKind !== "event") {
    throw new Error(`Browser capture dateKind must be event for ${source.id}`);
  }
  if (publishedAt && (!Number.isFinite(publishedAt.getTime()) || publishedAt.getTime() > now.getTime() + 5 * 60_000)) {
    throw new Error(`Capture publishedAt is invalid for ${source.id}`);
  }
  return {
    sourceId: source.id,
    externalKey: match[2]!,
    canonicalUrl: `https://x.com/${source.connector.config.username}/status/${match[2]}`,
    title,
    summary: text.slice(0, 1_000),
    capturedAt: generatedAt.toISOString(),
    ...(publishedAt ? { publishedAt: publishedAt.toISOString(), publishedRaw: capture.publishedAt } : {}),
    contentHash: createHash("sha256").update(text).digest("hex"),
    evidenceClass: "secondary",
    discoveryUrl: `https://x.com/${source.connector.config.username}`,
    discoveryChannel: "codex-browser",
    fetchStatus: "success",
    extractStatus: "success",
    attempts: 1,
    contentType: "text/plain",
    author: capture.author ? string(capture.author, "capture.author", 200) : `@${source.connector.config.username}`,
    parserVersion: "codex-browser-bundle-v1",
    analysisText: text,
  };
}

function normalizeComputerUseCapture(
  source: ComputerUseSource,
  capture: NonNullable<ExternalCaptureResult["captures"]>[number],
  generatedAt: Date,
  now: Date,
  seen: Set<string>,
): CaptureEnvelope {
  const canonical = computerUseUrl(source, string(capture.url, "capture.url", 1_000)).toString();
  if (seen.has(canonical)) throw new Error(`External capture bundle repeats URL ${canonical}`);
  seen.add(canonical);
  const text = string(capture.text, "capture.text", 10_000);
  const title = string(capture.title, "capture.title", 500);
  const publishedAt = capture.publishedAt === undefined ? undefined : new Date(string(capture.publishedAt, "capture.publishedAt", 80));
  const dateKind = capture.dateKind;
  if (dateKind !== undefined && dateKind !== "event" && dateKind !== "page-updated") {
    throw new Error(`Capture dateKind is invalid for ${source.id}`);
  }
  if (publishedAt && !dateKind) throw new Error(`Computer Use capture with publishedAt must declare dateKind for ${source.id}`);
  if (!publishedAt && dateKind) throw new Error(`Computer Use capture dateKind requires publishedAt for ${source.id}`);
  if (publishedAt && (!Number.isFinite(publishedAt.getTime()) || publishedAt.getTime() > now.getTime() + 5 * 60_000)) {
    throw new Error(`Capture publishedAt is invalid for ${source.id}`);
  }
  return {
    sourceId: source.id,
    externalKey: createHash("sha256").update(canonical).digest("hex").slice(0, 32),
    canonicalUrl: canonical,
    title,
    summary: text.slice(0, 1_000),
    capturedAt: generatedAt.toISOString(),
    ...(publishedAt && dateKind === "event" ? { publishedAt: publishedAt.toISOString(), publishedRaw: capture.publishedAt } : {}),
    ...(publishedAt && dateKind === "page-updated" ? { pageUpdatedAt: publishedAt.toISOString(), pageUpdatedRaw: capture.publishedAt } : {}),
    contentHash: createHash("sha256").update(text).digest("hex"),
    evidenceClass: source.evidenceTier === "primary" ? "primary" : "secondary",
    discoveryUrl: source.connector.config.url,
    discoveryChannel: "computer-use",
    fetchStatus: "success",
    extractStatus: "success",
    attempts: 1,
    contentType: "text/plain",
    ...(capture.author ? { author: string(capture.author, "capture.author", 200) } : {}),
    parserVersion: "computer-use-bundle-v1",
    analysisText: text,
  };
}

function normalizeInAppBrowserCapture(
  source: InAppBrowserSource,
  capture: NonNullable<ExternalCaptureResult["captures"]>[number],
  generatedAt: Date,
  now: Date,
  seen: Set<string>,
): CaptureEnvelope {
  const canonical = inAppBrowserUrl(source, string(capture.url, "capture.url", 1_000)).toString();
  if (seen.has(canonical)) throw new Error(`External capture bundle repeats URL ${canonical}`);
  seen.add(canonical);
  const text = string(capture.text, "capture.text", 10_000);
  const title = string(capture.title, "capture.title", 500);
  const publishedAt = capture.publishedAt === undefined ? undefined : new Date(string(capture.publishedAt, "capture.publishedAt", 80));
  const dateKind = capture.dateKind;
  if (dateKind !== undefined && dateKind !== "event" && dateKind !== "page-updated") throw new Error(`Capture dateKind is invalid for ${source.id}`);
  if (publishedAt && !dateKind) throw new Error(`In-app Browser capture with publishedAt must declare dateKind for ${source.id}`);
  if (!publishedAt && dateKind) throw new Error(`In-app Browser capture dateKind requires publishedAt for ${source.id}`);
  if (publishedAt && (!Number.isFinite(publishedAt.getTime()) || publishedAt.getTime() > now.getTime() + 5 * 60_000)) {
    throw new Error(`Capture publishedAt is invalid for ${source.id}`);
  }
  return {
    sourceId: source.id,
    externalKey: createHash("sha256").update(canonical).digest("hex").slice(0, 32),
    canonicalUrl: canonical,
    title,
    summary: text.slice(0, 1_000),
    capturedAt: generatedAt.toISOString(),
    ...(publishedAt && dateKind === "event" ? { publishedAt: publishedAt.toISOString(), publishedRaw: capture.publishedAt } : {}),
    ...(publishedAt && dateKind === "page-updated" ? { pageUpdatedAt: publishedAt.toISOString(), pageUpdatedRaw: capture.publishedAt } : {}),
    contentHash: createHash("sha256").update(text).digest("hex"),
    evidenceClass: source.evidenceTier === "primary" ? "primary" : "secondary",
    discoveryUrl: source.connector.config.url,
    discoveryChannel: "in-app-browser",
    fetchStatus: "success",
    extractStatus: "success",
    attempts: 1,
    contentType: "text/plain",
    ...(capture.author ? { author: string(capture.author, "capture.author", 200) } : {}),
    parserVersion: "in-app-browser-bundle-v1",
    analysisText: text,
  };
}

export async function loadExternalCaptureBundle(
  config: EffectiveConfig,
  bundlePath: string,
  now = new Date(),
  options: { allowStale?: boolean } = {},
): Promise<Map<string, ValidatedExternalCapture>> {
  const absolute = path.resolve(config.projectRoot, bundlePath);
  await assertSafeReadPath(config.projectRoot, absolute);
  const info = await stat(absolute);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("External capture bundle must be a regular file no larger than 2 MiB");
  let value: unknown;
  try { value = JSON.parse(await readFile(absolute, "utf8")); } catch { throw new Error("External capture bundle is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("External capture bundle must be an object");
  const bundle = value as Partial<ExternalCaptureBundle>;
  if (bundle.apiVersion !== "briefwright.dev/external-captures/v1") throw new Error("External capture bundle apiVersion is unsupported");
  const generatedAt = new Date(String(bundle.generatedAt));
  if (!Number.isFinite(generatedAt.getTime()) || generatedAt.getTime() > now.getTime() + 5 * 60_000
    || (!options.allowStale && now.getTime() - generatedAt.getTime() > 48 * 60 * 60_000)) {
    throw new Error("External capture bundle generatedAt must be within the last 48 hours and not in the future");
  }
  if (!Array.isArray(bundle.sources) || bundle.sources.length > 100) throw new Error("External capture bundle sources must be an array of at most 100 entries");
  const configured = new Map(config.preset.sources.filter(isExternalCaptureSource).map((source) => [source.id, source]));
  const output = new Map<string, ValidatedExternalCapture>();
  for (const raw of bundle.sources) {
    if (!raw || typeof raw !== "object") throw new Error("External capture source entry must be an object");
    const entry = raw as ExternalCaptureResult;
    const sourceId = string(entry.sourceId, "sourceId", 160);
    if (output.has(sourceId)) throw new Error(`External capture bundle repeats source ${sourceId}`);
    const source = configured.get(sourceId);
    if (!source) throw new Error(`External capture bundle targets an unknown external-capture source: ${sourceId}`);
    if (source.connector.type === "computer-use" && entry.captureMode !== "computer-use") {
      throw new Error(`Computer Use source ${sourceId} must declare captureMode computer-use`);
    }
    if (source.connector.type === "in-app-browser" && entry.captureMode !== "in-app-browser") {
      throw new Error(`In-app Browser source ${sourceId} must declare captureMode in-app-browser`);
    }
    if (source.connector.type === "codex-browser" && entry.captureMode && entry.captureMode !== "codex-browser") {
      throw new Error(`Browser source ${sourceId} has an incompatible captureMode`);
    }
    const status = entry.status;
    if (!(["captured", "unchanged", "failed"] as const).includes(status)) throw new Error(`External capture status is invalid for ${sourceId}`);
    const detail = entry.detail === undefined ? undefined : string(entry.detail, "detail", 500);
    const captures = entry.captures ?? [];
    if (!Array.isArray(captures) || captures.length > 20) throw new Error(`External captures for ${sourceId} must contain at most 20 entries`);
    if (status === "captured" && !captures.length) throw new Error(`Captured source ${sourceId} has no captures`);
    if (status !== "captured" && captures.length) throw new Error(`${status} source ${sourceId} cannot include captures`);
    const seen = new Set<string>();
    const normalized = captures.map((capture) => {
      if (!capture || typeof capture !== "object") throw new Error(`Capture for ${sourceId} must be an object`);
      return isCodexBrowserSource(source)
        ? normalizeXCapture(source, capture, generatedAt, now, seen)
        : isInAppBrowserSource(source)
          ? normalizeInAppBrowserCapture(source, capture, generatedAt, now, seen)
        : isComputerUseSource(source)
          ? normalizeComputerUseCapture(source, capture, generatedAt, now, seen)
          : (() => { throw new Error(`Unsupported external capture source ${sourceId}`); })();
    });
    output.set(sourceId, { sourceId, status, captures: normalized, ...(detail ? { detail } : {}) });
  }
  return output;
}
