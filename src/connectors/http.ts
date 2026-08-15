import { lookup } from "node:dns";
import type { LookupFunction } from "node:net";

import ipaddr from "ipaddr.js";
import { Agent, Pool, type Dispatcher } from "undici";
import type { SourceDefinition } from "../config/types.js";

const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_DESTROY_TIMEOUT_MS = 2_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface DispatcherLifecycle {
  close(): Promise<void>;
  destroy(error?: Error | null): Promise<void>;
}

export interface HttpClientCloseResult {
  mode: "graceful" | "forced" | "cleanup-timeout" | "cleanup-error";
  detail: string;
}

export interface HttpClientDependencies {
  fetch?: typeof fetch;
  dispatcher?: DispatcherLifecycle;
  fallbackDispatchers?: DispatcherLifecycle[];
  closeTimeoutMs?: number;
  destroyTimeoutMs?: number;
}

interface BoundedOperationResult {
  status: "completed" | "timed-out" | "failed";
  error?: unknown;
}

async function runBounded(operation: () => Promise<unknown>, timeoutMs: number): Promise<BoundedOperationResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BoundedOperationResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timed-out" }), timeoutMs);
  });
  const work: Promise<BoundedOperationResult> = Promise.resolve()
    .then(operation)
    .then(
      () => ({ status: "completed" as const }),
      (error: unknown) => ({ status: "failed" as const, error }),
    );
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function destroyDispatchers(
  dispatchers: Iterable<DispatcherLifecycle>,
  timeoutMs: number,
  reason: Error,
): Promise<BoundedOperationResult> {
  const unique = [...new Set(dispatchers)];
  return runBounded(async () => {
    const results = await Promise.allSettled(unique.map((dispatcher) => Promise.resolve().then(() => dispatcher.destroy(reason))));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }, timeoutMs);
}

async function closeDispatcherBounded(
  dispatcher: DispatcherLifecycle,
  fallbackDispatchers: Iterable<DispatcherLifecycle>,
  options: { closeTimeoutMs: number; destroyTimeoutMs: number; force: boolean },
): Promise<HttpClientCloseResult> {
  const targets = [dispatcher, ...fallbackDispatchers];
  if (options.force) {
    const destroyed = await destroyDispatchers(targets, options.destroyTimeoutMs, new Error("Briefwright aborted a dispatcher after a failed HTTP request"));
    if (destroyed.status === "completed") return { mode: "forced", detail: "HTTP request failed; dispatcher connections were destroyed instead of waiting for graceful close" };
    if (destroyed.status === "timed-out") return { mode: "cleanup-timeout", detail: `Dispatcher destroy did not settle within ${options.destroyTimeoutMs}ms after a failed request` };
    return { mode: "cleanup-error", detail: `Dispatcher destroy failed after a failed request: ${errorDetail(destroyed.error)}` };
  }

  const closed = await runBounded(() => dispatcher.close(), options.closeTimeoutMs);
  if (closed.status === "completed") return { mode: "graceful", detail: "HTTP dispatcher closed gracefully" };

  const closeDetail = closed.status === "timed-out"
    ? `Graceful dispatcher close exceeded ${options.closeTimeoutMs}ms`
    : `Graceful dispatcher close failed: ${errorDetail(closed.error)}`;
  const destroyed = await destroyDispatchers(targets, options.destroyTimeoutMs, new Error(closeDetail));
  if (destroyed.status === "completed") return { mode: "forced", detail: `${closeDetail}; tracked dispatcher connections were destroyed` };
  if (destroyed.status === "timed-out") return { mode: "cleanup-timeout", detail: `${closeDetail}; destroy did not settle within ${options.destroyTimeoutMs}ms` };
  return { mode: "cleanup-error", detail: `${closeDetail}; destroy failed: ${errorDetail(destroyed.error)}` };
}

export function allowedHostsForSource(source: SourceDefinition): string[] {
  if (source.connector.type === "github-releases") return ["api.github.com", "github.com"];
  if (source.connector.type === "rss") return [new URL(source.connector.config.url).hostname];
  if (source.connector.type === "webpage") return [new URL(source.connector.config.url).hostname];
  if (source.connector.type === "x-api") return ["api.x.com"];
  if (source.connector.type === "codex-browser") return [];
  if (source.connector.type === "in-app-browser") return [];
  if (source.connector.type === "computer-use") return [];
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
  return (hostname, options, callback) => {
    let settled = false;
    const finish: typeof callback = (error, address, family) => { if (settled) return; settled = true; clearTimeout(timer); callback(error, address, family); };
    const timer = setTimeout(() => finish(Object.assign(new Error(`DNS lookup timed out for ${hostname}`), { code: "ETIMEOUT" }) as NodeJS.ErrnoException, "", 0), 5_000);
    lookup(hostname, options, (error, address, family) => {
    if (error) return finish(error, address, family);
    try {
      const addresses = Array.isArray(address) ? address.map((item) => item.address) : [address];
      for (const item of addresses) {
        assertPublicAddress(item, allowedHosts.has(normalizedHostname(hostname)));
      }
      finish(null, address, family);
    } catch (lookupError) {
      finish(lookupError as NodeJS.ErrnoException, address, family);
    }
    });
  };
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
}, dependencies: HttpClientDependencies = {}): ((url: string, init?: RequestInit) => Promise<Response>) & { close(): Promise<HttpClientCloseResult> } {
  const allowedHosts = new Set(options.allowedHosts.map(normalizedHostname));
  const trackedDispatchers = new Set<DispatcherLifecycle>(dependencies.fallbackDispatchers ?? []);
  const secureDispatcher = dependencies.dispatcher ?? new Agent({
    connect: { lookup: createSecureLookup(allowedHosts) },
    factory: (origin, dispatcherOptions) => {
      const pool = new Pool(origin, dispatcherOptions);
      trackedDispatchers.add(pool);
      return pool;
    },
  });
  const fetchImplementation = dependencies.fetch ?? fetch;
  let requestFailed = false;
  let closePromise: Promise<HttpClientCloseResult> | undefined;
  const client = async (rawUrl: string, init: RequestInit = {}) => {
    const url = assertPublicHttpsUrl(rawUrl);
    const sourceHostname = normalizedHostname(url.hostname);
    if (!allowedHosts.has(sourceHostname)) {
      throw new Error(`Connector host is not declared by the active preset: ${url.hostname}`);
    }
    let lastError: unknown;

    for (let attempt = 0; attempt <= options.retries; attempt += 1) {
      try {
        let currentUrl = url;
        let response: Response;
        const signal = AbortSignal.timeout(options.timeoutSeconds * 1_000);
        for (let redirectCount = 0;; redirectCount += 1) {
          response = await fetchImplementation(currentUrl, {
            ...init,
            redirect: "manual",
            signal,
            headers: {
              "user-agent": options.userAgent ?? "Briefwright/1.0 (+https://github.com/RacYang/briefwright)",
              ...init.headers,
            },
            dispatcher: secureDispatcher as Dispatcher,
          } as RequestInit & { dispatcher: Dispatcher });
          if (!REDIRECT_STATUSES.has(response.status)) break;
          const location = response.headers.get("location");
          if (!location) {
            await response.body?.cancel();
            throw new Error(`Connector received HTTP ${response.status} without a Location header`);
          }
          if (redirectCount >= MAX_REDIRECTS) {
            await response.body?.cancel();
            throw new Error(`Connector exceeded the ${MAX_REDIRECTS}-redirect limit`);
          }
          const target = assertPublicHttpsUrl(new URL(location, currentUrl).toString());
          await response.body?.cancel();
          if (normalizedHostname(target.hostname) !== sourceHostname) {
            throw new Error(`Connector redirect target host is not the original source host: ${target.hostname}`);
          }
          currentUrl = target;
        }
        if (response.status >= 500 && attempt < options.retries) {
          await response.body?.cancel();
          await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
          continue;
        }
        return response;
      } catch (error) {
        requestFailed = true;
        lastError = error;
        if (attempt === options.retries) break;
        await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
  return Object.assign(client, {
    close: () => closePromise ??= closeDispatcherBounded(secureDispatcher, trackedDispatchers, {
      closeTimeoutMs: dependencies.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
      destroyTimeoutMs: dependencies.destroyTimeoutMs ?? DEFAULT_DESTROY_TIMEOUT_MS,
      force: requestFailed,
    }),
  });
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
