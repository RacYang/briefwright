import type { ProviderDefinition } from "../config/types.js";
import { AnthropicMessagesProvider } from "./anthropic.js";
import { CodexExecProvider } from "./codex.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import type { ModelProvider } from "./types.js";

export type ModelProviderFactory = (definition: ProviderDefinition) => ModelProvider;

const factories = new Map<string, ModelProviderFactory>([
  ["openai-chat-completions", (definition) => new OpenAICompatibleProvider(definition.id)],
  ["anthropic-messages", () => new AnthropicMessagesProvider()],
  ["codex-exec", () => new CodexExecProvider()],
]);

export function registerModelProtocol(protocol: string, factory: ModelProviderFactory): () => void {
  if (!/^[a-z][a-z0-9-]*$/.test(protocol)) throw new Error(`Invalid model protocol ID: ${protocol}`);
  if (factories.has(protocol)) throw new Error(`Model protocol is already registered: ${protocol}`);
  factories.set(protocol, factory);
  return () => { factories.delete(protocol); };
}

export function providerFor(definition: ProviderDefinition): ModelProvider {
  const factory = factories.get(definition.protocol);
  if (!factory) throw new Error(`No model adapter is registered for protocol '${definition.protocol}'`);
  return factory(definition);
}
