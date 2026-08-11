import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { EffectiveConfig, SourceDefinition } from "../config/types.js";
import { assertSafeReadPath } from "../config/paths.js";
import type { CaptureEnvelope } from "./types.js";

export interface ExternalCaptureResult {
  sourceId: string;
  status: "captured" | "unchanged" | "failed";
  captures?: Array<{ url: string; title: string; text: string; publishedAt?: string; author?: string }>;
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

function browserSource(source: SourceDefinition): source is SourceDefinition & { connector: { type: "codex-browser"; config: { username: string } } } {
  return source.connector.type === "codex-browser";
}

function string(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /\0/.test(value)) throw new Error(`${field} must be a non-empty string up to ${maximum} characters`);
  return value.trim();
}

export async function loadExternalCaptureBundle(config: EffectiveConfig, bundlePath: string, now = new Date()): Promise<Map<string, ValidatedExternalCapture>> {
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
  if (!Number.isFinite(generatedAt.getTime()) || generatedAt.getTime() > now.getTime() + 5 * 60_000 || now.getTime() - generatedAt.getTime() > 48 * 60 * 60_000) throw new Error("External capture bundle generatedAt must be within the last 48 hours and not in the future");
  if (!Array.isArray(bundle.sources) || bundle.sources.length > 100) throw new Error("External capture bundle sources must be an array of at most 100 entries");
  const configured = new Map(config.preset.sources.filter(browserSource).map((source) => [source.id, source]));
  const output = new Map<string, ValidatedExternalCapture>();
  for (const raw of bundle.sources) {
    if (!raw || typeof raw !== "object") throw new Error("External capture source entry must be an object");
    const sourceId = string((raw as ExternalCaptureResult).sourceId, "sourceId", 160);
    if (output.has(sourceId)) throw new Error(`External capture bundle repeats source ${sourceId}`);
    const source = configured.get(sourceId);
    if (!source) throw new Error(`External capture bundle targets an unknown browser source: ${sourceId}`);
    const status = (raw as ExternalCaptureResult).status;
    if (!(["captured", "unchanged", "failed"] as const).includes(status)) throw new Error(`External capture status is invalid for ${sourceId}`);
    const detail = (raw as ExternalCaptureResult).detail === undefined ? undefined : string((raw as ExternalCaptureResult).detail, "detail", 500);
    const captures = (raw as ExternalCaptureResult).captures ?? [];
    if (!Array.isArray(captures) || captures.length > 20) throw new Error(`External captures for ${sourceId} must contain at most 20 entries`);
    if (status === "captured" && !captures.length) throw new Error(`Captured source ${sourceId} has no captures`);
    if (status !== "captured" && captures.length) throw new Error(`${status} source ${sourceId} cannot include captures`);
    const seen = new Set<string>();
    const normalized = captures.map((capture) => {
      if (!capture || typeof capture !== "object") throw new Error(`Capture for ${sourceId} must be an object`);
      const url = string(capture.url, "capture.url", 1_000); const match = /^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d+)(?:\?.*)?$/.exec(url);
      if (!match || match[1]!.toLowerCase() !== source.connector.config.username.toLowerCase()) throw new Error(`Capture URL does not match @${source.connector.config.username} for ${sourceId}`);
      if (seen.has(match[2]!)) throw new Error(`External capture bundle repeats status ${match[2]}`); seen.add(match[2]!);
      const text = string(capture.text, "capture.text", 10_000); const title = string(capture.title, "capture.title", 500);
      const publishedAt = capture.publishedAt === undefined ? undefined : new Date(string(capture.publishedAt, "capture.publishedAt", 80));
      if (publishedAt && (!Number.isFinite(publishedAt.getTime()) || publishedAt.getTime() > now.getTime() + 5 * 60_000)) throw new Error(`Capture publishedAt is invalid for ${sourceId}`);
      return { sourceId, externalKey: match[2]!, canonicalUrl: `https://x.com/${source.connector.config.username}/status/${match[2]}`, title, summary: text.slice(0, 1_000),
        capturedAt: generatedAt.toISOString(), ...(publishedAt ? { publishedAt: publishedAt.toISOString(), publishedRaw: capture.publishedAt } : {}),
        contentHash: createHash("sha256").update(text).digest("hex"), evidenceClass: "secondary" as const, discoveryUrl: `https://x.com/${source.connector.config.username}`,
        discoveryChannel: "codex-browser", fetchStatus: "success" as const, extractStatus: "success" as const, attempts: 1, contentType: "text/plain",
        author: capture.author ? string(capture.author, "capture.author", 200) : `@${source.connector.config.username}`, parserVersion: "codex-browser-bundle-v1", analysisText: text };
    });
    output.set(sourceId, { sourceId, status, captures: normalized, ...(detail ? { detail } : {}) });
  }
  return output;
}
