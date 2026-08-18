import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

import { loadEffectiveConfig } from "../config/load.js";
import { assertSafeReadPath } from "../config/paths.js";
import { renderMarkdown } from "../outputs/markdown.js";
import { renderFormalDaily, renderFormalReview } from "../outputs/formal-markdown.js";
import { renderFormalDailyV1, renderFormalReviewV1 } from "../outputs/formal-markdown-v1.js";
import { SqliteStateStore } from "../state/sqlite.js";

export interface ReplayResult {
  runId: string;
  artifactPath: string;
  recordedHash: string;
  reproducedHash: string;
  diskHash: string;
  snapshotMatches: boolean;
  diskMatches: boolean;
  matches: boolean;
  artifacts: Array<{ kind: string; artifactPath: string; recordedHash: string; reproducedHash: string; diskHash: string; snapshotMatches: boolean; diskMatches: boolean }>;
}

function recordedDocumentManifest(content: string): { contractDigest: string; sourceManifestDigest: string } | null {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!match?.[1]) return null;
  const frontmatter = parse(match[1]) as Record<string, unknown>;
  const contractDigest = frontmatter.contract_digest;
  const sourceManifestDigest = frontmatter.source_manifest_digest;
  return typeof contractDigest === "string" && /^[a-f0-9]{64}$/.test(contractDigest)
    && typeof sourceManifestDigest === "string" && /^[a-f0-9]{64}$/.test(sourceManifestDigest)
    ? { contractDigest, sourceManifestDigest } : null;
}

function recordedFormalFormat(content: string): "v1" | "current" {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!match?.[1]) return "current";
  const frontmatter = parse(match[1]) as Record<string, unknown>;
  return typeof frontmatter.artifact_kind === "string"
    && typeof frontmatter.workflow_version === "string"
    && typeof frontmatter.policy_digest === "string"
    && typeof frontmatter.prompt_digest === "string"
    && typeof frontmatter.contract_digest !== "string"
    ? "v1"
    : "current";
}

export async function verifyReplay(configPath: string, runId: string): Promise<ReplayResult> {
  const current = await loadEffectiveConfig(configPath);
  const state = new SqliteStateStore(current.storage.path, current.projectRoot);
  try {
    const bundle = state.replayArtifacts(runId);
    const disk = new Map<string, { content: string; hash: string }>();
    for (const artifact of bundle.artifacts) {
      const artifactRoot = artifact.kind === "daily-markdown" || artifact.kind === "review-markdown"
        ? bundle.config.output.directory : bundle.config.projectRoot;
      await assertSafeReadPath(artifactRoot, artifact.path);
      const content = await readFile(artifact.path, "utf8");
      disk.set(artifact.path, { content, hash: createHash("sha256").update(content).digest("hex") });
    }
    let replayResult = bundle.result;
    if (!replayResult.documentManifest) {
      const manifests = bundle.artifacts.map((artifact) => {
        const observed = disk.get(artifact.path)!;
        return observed.hash === artifact.contentHash ? recordedDocumentManifest(observed.content) : null;
      });
      const first = manifests[0];
      if (first && manifests.every((manifest) => manifest?.contractDigest === first.contractDigest && manifest.sourceManifestDigest === first.sourceManifestDigest)) {
        replayResult = { ...replayResult, documentManifest: first };
      }
    }
    const artifacts = [];
    for (const artifact of bundle.artifacts) {
      const observed = disk.get(artifact.path)!;
      const formalFormat = recordedFormalFormat(observed.content);
      const rendered = artifact.kind === "daily-markdown"
        ? formalFormat === "v1" ? renderFormalDailyV1(bundle.config, replayResult) : renderFormalDaily(bundle.config, replayResult)
        : artifact.kind === "review-markdown"
          ? formalFormat === "v1" ? renderFormalReviewV1(bundle.config, replayResult) : renderFormalReview(bundle.config, replayResult)
          : renderMarkdown(bundle.config, replayResult);
      const reproducedHash = createHash("sha256").update(rendered).digest("hex");
      const diskHash = observed.hash;
      artifacts.push({ kind: artifact.kind, artifactPath: artifact.path, recordedHash: artifact.contentHash, reproducedHash, diskHash, snapshotMatches: reproducedHash === artifact.contentHash, diskMatches: diskHash === artifact.contentHash });
    }
    const primary = artifacts[0]!;
    const snapshotMatches = artifacts.every((artifact) => artifact.snapshotMatches);
    const diskMatches = artifacts.every((artifact) => artifact.diskMatches);
    return {
      runId,
      artifactPath: primary.artifactPath,
      recordedHash: primary.recordedHash,
      reproducedHash: primary.reproducedHash,
      diskHash: primary.diskHash,
      snapshotMatches,
      diskMatches,
      matches: snapshotMatches && diskMatches,
      artifacts,
    };
  } finally {
    state.close();
  }
}
