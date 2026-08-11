import { lookup } from "node:dns";
import type { LookupFunction } from "node:net";

import ipaddr from "ipaddr.js";
import { Agent } from "undici";
import type { SourceDefinition } from "../config/types.js";

export function allowedHostsForSource(source: SourceDefinition): string[] {
  if (source.connector.type === "github-releases") return ["api.github.com"];
  if (source.connector.type === "rss") return [new URL(source.connector.config.url).hostname];
  const value = source.connector.config.options.allowedHosts;
  if (!Array.isArray(value) || !value.length || value.some((host) => typeof host !== "string" || !/^[A-Za-z0-9.-]+$/.test(host))) {
    throw new Error(`Extension source ${source.id} must declare options.allowedHosts`);
  }
  return value as string[];
}

function normalizedHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function isBenchmarkProxyAddress(parsed: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  if (!(parsed instanceof ipaddr.IPv4)) return false;
  const [first, second] = parsed.toByteArray();
  return first === 198 && (second === 18 || second === 19);
}

export function assertPublicAddress(address: string, allowBenchmarkProxy = false): void {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.parse(normalizedHostname(address));
  } catch {
    throw new Error(`DNS returned an invalid address: ${address}`);
  }
  if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) {
    parsed = parsed.toIPv4Address();
  }
  if (parsed.range() !== "unicast" && !(allowBenchmarkProxy && isBenchmarkProxyAddress(parsed))) {
    throw new Error(`Connector may not target a non-public network address: ${address}`);
  }
}

function createSecureLookup(allowedHosts: Set<string>): LookupFunction {
  return (hostname, options, callback) => lookup(hostname, options, (error, address, family) => {
    if (error) return callback(error, address, family);
    try {
      const addresses = Array.isArray(address) ? address.map((item) => item.address) : [address];
      for (const item of addresses) {
        assertPublicAddress(item, allowedHosts.has(normalizedHostname(hostname)));
      }
      callback(null, address, family);
    } catch (lookupError) {
      callback(lookupError as NodeJS.ErrnoException, address, family);
    }
  });
}

export function assertPublicHttpsUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error(`Connector URL must use HTTPS: ${rawUrl}`);
  const hostname = normalizedHostname(url.hostname);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error(`Connector URL may not target localhost: ${rawUrl}`);
  }
  if (ipaddr.isValid(hostname)) assertPublicAddress(hostname);
  return url;
}

export function createHttpClient(options: {
  timeoutSeconds: number;
  retries: number;
  allowedHosts: string[];
  userAgent?: string;
}): (url: string, init?: RequestInit) => Promise<Response> {
  const allowedHosts = new Set(options.allowedHosts.map(normalizedHostname));
  const secureDispatcher = new Agent({ connect: { lookup: createSecureLookup(allowedHosts) } });
  return async (rawUrl, init = {}) => {
    const url = assertPublicHttpsUrl(rawUrl);
    if (!allowedHosts.has(normalizedHostname(url.hostname))) {
      throw new Error(`Connector host is not declared by the active preset: ${url.hostname}`);
    }
    let lastError: unknown;

    for (let attempt = 0; attempt <= options.retries; attempt += 1) {
      try {
        const response = await fetch(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(options.timeoutSeconds * 1_000),
          headers: {
            "user-agent": options.userAgent ?? "Briefwright/0.0 (+https://github.com/RacYang/briefwright)",
            ...init.headers,
          },
          dispatcher: secureDispatcher,
        } as RequestInit & { dispatcher: Agent });
        if (response.status >= 500 && attempt < options.retries) {
          await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt === options.retries) break;
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}

export async function readTextLimited(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`Response body exceeds the ${maximumBytes}-byte limit`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("Briefwright response-size limit reached");
        throw new Error(`Response body exceeds the ${maximumBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function readJsonLimited<T>(response: Response, maximumBytes: number): Promise<T> {
  const text = await readTextLimited(response, maximumBytes);
  return JSON.parse(text) as T;
}
