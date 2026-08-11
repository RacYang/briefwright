import { spawn } from "node:child_process";
import path from "node:path";

import type { EffectiveConfig } from "../config/types.js";
import { resolveWithinRoot } from "../config/paths.js";
import { writeArtifactSetAtomic } from "../outputs/write.js";
import type { DocumentArtifact, DocumentStore, PublishedDocument } from "./types.js";

export class FilesystemDocumentStore implements DocumentStore {
  readonly driver: "local" | "obsidian";
  readonly root: string;
  constructor(config: EffectiveConfig["documents"]) { this.driver = config.driver; this.root = config.root; }
  resolve(relativePath: string): string { return resolveWithinRoot(this.root, relativePath); }
  async publish(artifacts: DocumentArtifact[], commit: () => void): Promise<PublishedDocument[]> {
    const resolved = artifacts.map((artifact) => ({ ...artifact, path: this.resolve(artifact.relativePath) }));
    await writeArtifactSetAtomic(this.root, resolved.map((artifact) => ({ path: artifact.path, content: artifact.content })), commit);
    return resolved.map((artifact) => ({ kind: artifact.kind, path: artifact.path, ...(this.driver === "obsidian" ? { uri: this.obsidianUri(artifact.path) } : {}) }));
  }
  private obsidianUri(pathname: string): string {
    const relative = path.relative(this.root, pathname).split(path.sep).join("/");
    return `obsidian://open?path=${encodeURIComponent(relative)}`;
  }
  open(pathname: string): void {
    const target = this.driver === "obsidian" ? this.obsidianUri(pathname) : pathname;
    const command = process.platform === "darwin" ? { file: "open", args: [target] }
      : process.platform === "win32" ? { file: "explorer.exe", args: [target] }
      : { file: "xdg-open", args: [target] };
    const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" }); child.unref();
  }
}

export function documentStoreFor(config: EffectiveConfig): DocumentStore { return new FilesystemDocumentStore(config.documents); }
