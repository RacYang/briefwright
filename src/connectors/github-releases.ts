import { createHash } from "node:crypto";

import type { SourceDefinition } from "../config/types.js";
import { assertPublicHttpsUrl, readJsonLimited } from "./http.js";
import type { CaptureEnvelope, Connector, ConnectorContext } from "./types.js";

type GithubSource = SourceDefinition & {
  connector: { type: "github-releases"; config: { repository: string } };
};

interface GithubRelease {
  id: number;
  html_url: string;
  name: string | null;
  tag_name: string;
  body: string | null;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
}

function summary(body: string | null): string {
  const plain = (body ?? "No release notes supplied.")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`\[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain.split(/\s+/u).slice(0, 25).join(" ").slice(0, 500);
}

export class GithubReleasesConnector implements Connector<GithubSource> {
  readonly descriptor = {
    type: "github-releases" as const,
    version: "1.0.0",
    title: "GitHub releases",
    requiresCredentials: false,
    capabilities: ["capture", "conditional-fetch", "releases"],
    owner: "briefwright-core",
    riskLabels: ["external-markdown", "rate-limited"],
    configSchema: { type: "object", additionalProperties: false, required: ["repository"], properties: { repository: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" } } },
    examples: [{ repository: "QwenLM/qwen-code" }],
    authentication: { required: false, secretFields: [] },
  };

  private apiUrl(source: GithubSource): string {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.connector.config.repository)) {
      throw new Error(`Invalid GitHub repository: ${source.connector.config.repository}`);
    }
    return `https://api.github.com/repos/${source.connector.config.repository}/releases?per_page=5`;
  }

  async check(source: GithubSource, context: ConnectorContext) {
    const response = await context.fetch(this.apiUrl(source), {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
    return response.ok
      ? { ok: true, detail: `${source.connector.config.repository} is accessible` }
      : { ok: false, detail: `GitHub returned HTTP ${response.status}` };
  }

  async capture(source: GithubSource, context: ConnectorContext): Promise<CaptureEnvelope[]> {
    const response = await context.fetch(this.apiUrl(source), {
      headers: {
        accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
        ...(typeof context.cursor?.etag === "string" ? { "if-none-match": context.cursor.etag } : {}),
        ...(typeof context.cursor?.lastModified === "string" ? { "if-modified-since": context.cursor.lastModified } : {}),
      },
    });
    if (response.status === 304) {
      context.setCursor?.({ notModified: true });
      return [];
    }
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
    context.setCursor?.({
      ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
      ...(response.headers.get("last-modified") ? { lastModified: response.headers.get("last-modified")! } : {}),
    });
    const releases = await readJsonLimited<GithubRelease[]>(response, 2 * 1024 * 1024);
    return releases
      .filter((release) => !release.draft && !release.prerelease)
      .flatMap((release) => {
        let canonicalUrl: string;
        try {
          canonicalUrl = assertPublicHttpsUrl(release.html_url).toString();
        } catch {
          return [];
        }
        const content = `${release.name ?? release.tag_name}\n${release.body ?? ""}`;
        return [{
          sourceId: source.id,
          externalKey: String(release.id),
          canonicalUrl,
          title: release.name ?? release.tag_name,
          summary: summary(release.body),
          capturedAt: context.now().toISOString(),
          ...(release.published_at ? { publishedAt: release.published_at } : {}),
          contentHash: createHash("sha256").update(content).digest("hex"),
          evidenceClass: "primary" as const,
        }];
      });
  }
}

export function isGithubSource(source: SourceDefinition): source is GithubSource {
  return source.connector.type === "github-releases";
}
