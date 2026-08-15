import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { systemLarkRunner } from "../src/control-plane/lark-cli.js";

describe("system lark-cli runner", () => {
  it("kills a non-terminating subprocess at the configured deadline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-lark-timeout-"));
    const executable = path.join(root, "lark-cli.mjs");
    await writeFile(executable, "while (true) {}\n", "utf8");
    expect(() => systemLarkRunner(undefined, { timeoutMs: 50, readRetries: 0, executable: process.execPath, prefixArgs: [executable] })(["--version"])).toThrow("timed out after 50 ms");
  });

  it("retries a transient read failure but never broadens that policy to writes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-lark-retry-"));
    const executable = path.join(root, "lark-cli.mjs");
    const counter = path.join(root, "counter");
    await writeFile(executable, `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const counter = ${JSON.stringify(counter)};
const count = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
writeFileSync(counter, String(count));
if (process.argv[3] === "+record-upsert" || count === 1) {
  console.error('{"ok":false,"error":{"type":"network","subtype":"timeout","message":"TLS handshake timeout"}}');
  process.exit(1);
}
console.log('{"ok":true,"data":{"record_id_list":[],"fields":[],"data":[],"has_more":false}}');
`, "utf8");
    const runner = systemLarkRunner(undefined, { readRetries: 1, retryDelayMs: 0, executable: process.execPath, prefixArgs: [executable] });
    expect(runner(["base", "+record-list"])).toMatchObject({ has_more: false });
    expect(() => runner(["base", "+record-upsert"])).toThrow("TLS handshake timeout");
    expect((await readFile(counter, "utf8")).trim()).toBe("3");
  });

  it.each(["+record-list", "+record-get", "+data-query"])("retries transient failures for the %s read path", async (operation) => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-lark-read-retry-"));
    const executable = path.join(root, "lark-cli.mjs");
    const counter = path.join(root, "counter");
    await writeFile(executable, `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const counter = ${JSON.stringify(counter)};
const count = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1;
writeFileSync(counter, String(count));
if (count === 1) {
  console.error('{"ok":false,"error":{"type":"network","subtype":"timeout","message":"connection reset"}}');
  process.exit(1);
}
console.log('{"ok":true,"data":{"record_id_list":[],"fields":[],"data":[],"has_more":false,"main_data":[]}}');
`, "utf8");
    const runner = systemLarkRunner(undefined, { readRetries: 1, retryDelayMs: 0, executable: process.execPath, prefixArgs: [executable] });
    expect(runner(["base", operation])).toMatchObject({ record_id_list: [] });
    expect((await readFile(counter, "utf8")).trim()).toBe("2");
  });
});
