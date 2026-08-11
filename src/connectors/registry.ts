import type { SourceDefinition } from "../config/types.js";
import { GithubReleasesConnector, isGithubSource } from "./github-releases.js";
import { isRssSource, RssConnector } from "./rss.js";
import type { Connector } from "./types.js";

const github = new GithubReleasesConnector();
const rss = new RssConnector();
const extensions = new Map<string, Connector>();

export function registerConnector(adapter: string, connector: Connector): () => void {
  if (!/^[a-z][a-z0-9-]*$/.test(adapter)) throw new Error(`Invalid connector adapter ID: ${adapter}`);
  if (extensions.has(adapter)) throw new Error(`Connector adapter is already registered: ${adapter}`);
  extensions.set(adapter, connector);
  return () => { extensions.delete(adapter); };
}

export function connectorFor(source: SourceDefinition): Connector {
  if (isGithubSource(source)) return github as Connector;
  if (isRssSource(source)) return rss as Connector;
  if (source.connector.type === "extension") {
    const connector = extensions.get(source.connector.config.adapter);
    if (!connector) throw new Error(`Extension connector is not registered: ${source.connector.config.adapter}`);
    return connector;
  }
  throw new Error(`Unsupported connector: ${JSON.stringify(source.connector)}`);
}
