import type { SourceDefinition } from "../config/types.js";
import { GithubReleasesConnector, isGithubSource } from "./github-releases.js";
import { isRssSource, RssConnector } from "./rss.js";
import type { Connector } from "./types.js";

const github = new GithubReleasesConnector();
const rss = new RssConnector();

export function connectorFor(source: SourceDefinition): Connector {
  if (isGithubSource(source)) return github as Connector;
  if (isRssSource(source)) return rss as Connector;
  throw new Error(`Unsupported connector: ${JSON.stringify(source.connector)}`);
}
