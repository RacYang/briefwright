import { Ajv2020 } from "ajv/dist/2020.js";

import type { SourceDefinition } from "./config/types.js";
import type { Connector, ConnectorContext, ConnectorDescriptor } from "./connectors/types.js";
import { registerConnector } from "./connectors/registry.js";

export type { CaptureEnvelope, CheckResult, Connector, ConnectorContext, ConnectorDescriptor } from "./connectors/types.js";
export type { SourceDefinition } from "./config/types.js";

export function defineConnector<TSource extends SourceDefinition>(connector: Connector<TSource>): Connector<TSource> {
  validateConnectorDescriptor(connector.descriptor);
  return connector;
}

export function validateConnectorDescriptor(descriptor: ConnectorDescriptor): void {
  const problems: string[] = [];
  if (!/^[a-z][a-z0-9-]*$/.test(descriptor.type)) problems.push("type must be a lowercase adapter ID");
  if (!/^\d+\.\d+\.\d+$/.test(descriptor.version)) problems.push("version must be semantic x.y.z");
  if (!descriptor.capabilities.length) problems.push("capabilities must not be empty");
  if (!descriptor.owner.trim()) problems.push("owner is required");
  if (!descriptor.examples.length) problems.push("at least one example is required");
  try { new Ajv2020({ strict: true }).compile(descriptor.configSchema); } catch (error) { problems.push(`configSchema is invalid: ${error instanceof Error ? error.message : String(error)}`); }
  if (problems.length) throw new Error(`Invalid connector descriptor: ${problems.join("; ")}`);
}

export async function verifyConnectorContract<TSource extends SourceDefinition>(connector: Connector<TSource>, source: TSource, context: ConnectorContext): Promise<{ checked: boolean; captureCount: number }> {
  validateConnectorDescriptor(connector.descriptor);
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(connector.descriptor.configSchema);
  const config = source.connector.type === "extension" ? source.connector.config.options : source.connector.config;
  if (!validate(config)) throw new Error(`Connector fixture config is invalid: ${JSON.stringify(validate.errors)}`);
  const check = await connector.check(source, context);
  if (!check.ok) throw new Error(`Connector check failed: ${check.detail}`);
  const captures = await connector.capture(source, context);
  const identities = new Set<string>();
  for (const capture of captures) {
    if (capture.sourceId !== source.id) throw new Error("Connector returned a capture for another source");
    if (!capture.externalKey || !capture.contentHash || !capture.canonicalUrl.startsWith("https://")) throw new Error("Connector returned an incomplete capture envelope");
    const identity = `${capture.externalKey}\n${capture.contentHash}`;
    if (identities.has(identity)) throw new Error("Connector returned duplicate capture identities");
    identities.add(identity);
  }
  return { checked: true, captureCount: captures.length };
}

export { registerConnector };
