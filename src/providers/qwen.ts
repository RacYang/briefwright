import { OpenAICompatibleProvider } from "./openai-compatible.js";

/** Backward-compatible Qwen adapter. New runtime resolution is protocol-based. */
export class QwenProvider extends OpenAICompatibleProvider {
  constructor(fetcher: typeof fetch = fetch) { super("qwen", fetcher); }
}
