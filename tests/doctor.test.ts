import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { initializeProject } from "../src/commands/init.js";
import { doctorReport, runDoctor } from "../src/commands/doctor.js";
import { createHttpClient } from "../src/connectors/http.js";
import { FixtureModelProvider } from "../src/providers/fixture.js";

describe("doctor diagnostics", () => {
  it("validates a fresh project without creating output or state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-doctor-"));
    const configPath = await initializeProject({ directory: root, yes: true });
    const checks = await runDoctor(configPath);
    expect(checks.every((check) => check.ok)).toBe(true);
    await expect(access(path.join(root, "briefs"))).rejects.toThrow();
    await expect(access(path.join(root, ".briefwright"))).rejects.toThrow();
  });

  it("rejects an existing output target that is a regular file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-doctor-file-"));
    const configPath = await initializeProject({ directory: root, yes: true });
    await writeFile(path.join(root, "briefs"), "not a directory", "utf8");
    const checks = await runDoctor(configPath);
    expect(checks.find((check) => check.name === "output-boundary")).toMatchObject({
      ok: false,
      detail: expect.stringContaining("not a directory"),
    });
  });

  it("finishes online doctor with structured blocking connector failures after 308 redirect failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-doctor-redirect-"));
    const configPath = await initializeProject({ directory: root, yes: true, model: "ollama" });
    const dispatcher = {
      close: vi.fn(() => new Promise<void>(() => {})),
      destroy: vi.fn(async () => {}),
    };
    const trackedPool = { close: vi.fn(async () => {}), destroy: vi.fn(async () => {}) };
    const httpClientFactory: typeof createHttpClient = (options) => createHttpClient(options, {
      fetch: vi.fn<typeof fetch>(async (_input, init) => {
        expect(init?.redirect).toBe("manual");
        throw new TypeError("fetch failed", { cause: new Error("unexpected redirect (status 308)") });
      }),
      dispatcher,
      fallbackDispatchers: [trackedPool],
      closeTimeoutMs: 10,
      destroyTimeoutMs: 50,
    });

    const checks = await Promise.race([
      runDoctor(configPath, { online: true }, {
        httpClientFactory,
        modelProviderFactory: () => new FixtureModelProvider(),
      }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("doctor exceeded test deadline")), 1_000)),
    ]);
    const report = doctorReport(checks);
    const connectorWarnings = checks.filter((check) => check.name.startsWith("connector:") && !check.ok);

    expect(connectorWarnings.length).toBeGreaterThan(0);
    expect(connectorWarnings.every((check) => check.blocking !== false)).toBe(true);
    expect(connectorWarnings.some((check) => check.detail.includes("unexpected redirect (status 308)"))).toBe(true);
    expect(checks.find((check) => check.name === "connector-http-cleanup")).toMatchObject({
      ok: false,
      blocking: false,
      detail: expect.stringContaining("destroyed"),
    });
    expect(report.ok).toBe(false);
    expect(() => JSON.parse(JSON.stringify(report))).not.toThrow();
    expect(dispatcher.close).not.toHaveBeenCalled();
    expect(trackedPool.destroy).toHaveBeenCalledOnce();
  });

  it("keeps external-capture diagnostics advisory until a bundle is validated", () => {
    const report = doctorReport([{ name: "connector:SRC-X", ok: false, blocking: false, detail: "validate a current browser capture bundle" }]);
    expect(report.ok).toBe(true);
  });
});
