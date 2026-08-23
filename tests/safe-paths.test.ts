import { mkdtemp, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readStableDirectory, readStableOptionalRegularFile } from "../src/config/paths.js";
import { VaultPathUnsafeError } from "../src/errors.js";

describe("stable vault reads", () => {
  it("rejects a file replaced by an outside symlink after initial validation", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "briefwright-safe-file-"));
    const root = path.join(parent, "vault");
    const outside = path.join(parent, "outside.md");
    const target = path.join(root, "note.md");
    await mkdir(root);
    await writeFile(target, "inside", "utf8");
    await writeFile(outside, "outside-secret", "utf8");

    let observed: string | undefined;
    let caught: unknown;
    try {
      observed = await readStableOptionalRegularFile(root, target, {
        afterInitialValidation: async () => {
          await rename(target, `${target}.original`);
          await symlink(outside, target);
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(observed).toBeUndefined();
    expect(caught).toBeInstanceOf(VaultPathUnsafeError);
    expect((caught as VaultPathUnsafeError).path).toBe(target);
    expect((caught as VaultPathUnsafeError).phase).toBe("file-read");
  });

  it("rejects a directory replaced by an outside symlink during enumeration", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "briefwright-safe-directory-"));
    const root = path.join(parent, "vault");
    const directory = path.join(root, "notes");
    const outside = path.join(parent, "outside");
    await mkdir(directory, { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(directory, "inside.md"), "inside", "utf8");
    await writeFile(path.join(outside, "outside.md"), "outside-secret", "utf8");

    let caught: unknown;
    try {
      await readStableDirectory(root, directory, {
        afterInitialValidation: async () => {
          await rename(directory, `${directory}.original`);
          await symlink(outside, directory);
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(VaultPathUnsafeError);
    expect((caught as VaultPathUnsafeError).path).toBe(directory);
    expect((caught as VaultPathUnsafeError).phase).toBe("directory-enumeration");
  });

  it("returns stable file contents and a stable absence on the ordinary path", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-safe-control-"));
    const existing = path.join(root, "note.md");
    await writeFile(existing, "inside", "utf8");

    await expect(readStableOptionalRegularFile(root, existing)).resolves.toBe("inside");
    await expect(readStableOptionalRegularFile(root, path.join(root, "missing", "note.md"))).resolves.toBeUndefined();
  });
});
