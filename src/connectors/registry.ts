import type { SourceDefinition } from "../config/types.js";
import { GithubReleasesConnector, isGithubSource } from "./github-releases.js";
import { isRssSource, RssConnector } from "./rss.js";
import { isWebpageSource, WebpageConnector } from "./webpage.js";
import type { Connector } from "./types.js";
import { isXSource, XApiConnector } from "./x-api.js";
import { CodexBrowserConnector, isCodexBrowserSource } from "./codex-browser.js";
import { ComputerUseConnector, isComputerUseSource } from "./computer-use.js";
import { InAppBrowserConnector, isInAppBrowserSource } from "./in-app-browser.js";

const github = new GithubReleasesConnector();
const rss = new RssConnector();
const webpage = new WebpageConnector();
const x = new XApiConnector();
const codexBrowser = new CodexBrowserConnector();
const computerUse = new ComputerUseConnector();
const inAppBrowser = new InAppBrowserConnector();
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
  if (isWebpageSource(source)) return webpage as Connector;
  if (isXSource(source)) return x as Connector;
  if (isCodexBrowserSource(source)) return codexBrowser as Connector;
  if (isInAppBrowserSource(source)) return inAppBrowser as Connector;
  if (isComputerUseSource(source)) return computerUse as Connector;
  if (source.connector.type === "extension") {
    const connector = extensions.get(source.connector.config.adapter);
    if (!connector) throw new Error(`Extension connector is not registered: ${source.connector.config.adapter}`);
    return connector;
  }
  throw new Error(`Unsupported connector: ${JSON.stringify(source.connector)}`);
}
