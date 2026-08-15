import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { systemLarkRunner } from "../src/control-plane/lark-cli.js";

describe("system lark-cli runner", () => {
  it("kills a non-terminating subprocess at the configured deadline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-lark-timeout-"));
    const executable = path.join(root, "lark-cli");
    await writeFile(executable, "#!/bin/sh\nwhile :; do :; done\n", "utf8");
    await chmod(executable, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;
    try {
      expect(() => systemLarkRunner(undefined, { timeoutMs: 50, readRetries: 0 })(["--version"])).toThrow("timed out after 50 ms");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("retries a transient read failure but never broadens that policy to writes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-lark-retry-"));
    const executable = path.join(root, "lark-cli");
    const counter = path.join(root, "counter");
    await writeFile(executable, `#!/bin/sh
counter='${counter}'
count=0
[ -f "$counter" ] && count=$(cat "$counter")
count=$((count + 1))
echo "$count" > "$counter"
if [ "$2" = "+record-upsert" ]; then
  echo '{"ok":false,"error":{"type":"network","subtype":"timeout","message":"TLS handshake timeout"}}' >&2
  exit 1
fi
if [ "$count" -eq 1 ]; then
  echo '{"ok":false,"error":{"type":"network","subtype":"timeout","message":"TLS handshake timeout"}}' >&2
  exit 1
fi
echo '{"ok":true,"data":{"record_id_list":[],"fields":[],"data":[],"has_more":false}}'
`, "utf8");
    await chmod(executable, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;
    try {
      const runner = systemLarkRunner(undefined, { readRetries: 1, retryDelayMs: 0 });
      expect(runner(["base", "+record-list"])).toMatchObject({ has_more: false });
      expect(() => runner(["base", "+record-upsert"])).toThrow("TLS handshake timeout");
      expect((await readFile(counter, "utf8")).trim()).toBe("3");
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it.each(["+record-list", "+record-get", "+data-query"])("retries transient failures for the %s read path", async (operation) => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-lark-read-retry-"));
    const executable = path.join(root, "lark-cli");
    const counter = path.join(root, "counter");
    await writeFile(executable, `#!/bin/sh
counter='${counter}'
count=0
[ -f "$counter" ] && count=$(cat "$counter")
count=$((count + 1))
echo "$count" > "$counter"
if [ "$count" -eq 1 ]; then
  echo '{"ok":false,"error":{"type":"network","subtype":"timeout","message":"connection reset"}}' >&2
  exit 1
fi
echo '{"ok":true,"data":{"record_id_list":[],"fields":[],"data":[],"has_more":false,"main_data":[]}}'
`, "utf8");
    await chmod(executable, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;
    try {
      const runner = systemLarkRunner(undefined, { readRetries: 1, retryDelayMs: 0 });
      expect(runner(["base", operation])).toMatchObject({ record_id_list: [] });
      expect((await readFile(counter, "utf8")).trim()).toBe("2");
    } finally {
      process.env.PATH = previousPath;
    }
  });
});
