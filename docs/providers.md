# Model providers

The model layer is a registry, not a Qwen branch. `openai-chat-completions` and `anthropic-messages` are bundled protocols; `registerModelProtocol()` adds another runtime adapter without weakening evidence validation.

## Bundled presets

| ID | Protocol | Secret | Official reference |
|---|---|---|---|
| `codex` | local `codex exec` with a strict JSON schema | local Codex login | [Codex](https://developers.openai.com/codex/) |
| `openai` | OpenAI Chat Completions | `OPENAI_API_KEY` | [OpenAI models](https://platform.openai.com/docs/models) |
| `anthropic` | Anthropic Messages | `ANTHROPIC_API_KEY` | [Claude models](https://platform.claude.com/docs/en/about-claude/models/overview) |
| `gemini` | Google OpenAI compatibility | `GEMINI_API_KEY` | [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai) |
| `qwen` | Alibaba OpenAI compatibility | `DASHSCOPE_API_KEY` | [Model Studio text generation](https://help.aliyun.com/en/model-studio/text-generation) |
| `ollama` | Local OpenAI compatibility | none | localhost only |

The preset model is a starting point. Model availability changes; override `model` through an ejected Profile or a structured `briefing.yaml` provider. Online doctor makes a real provider request before scheduling.

The `codex` preset is useful when the briefing itself runs as a Codex Desktop automation. Briefwright launches an ephemeral, read-only `codex exec`, disables project rules and user configuration for that child, bounds its output and timeout, and validates the same structured analysis contract used by API providers. It inherits no provider API-key variables. The automation may choose Codex while another installation chooses any API or local provider; no process-store or document-store behavior depends on this choice.

```yaml
model:
  provider: my-compatible-provider
  protocol: openai-chat-completions
  model: my-model
  baseUrl: https://models.example.com/v1
  apiKey: { provider: env, key: MY_MODEL_API_KEY }
  allowedHosts: [models.example.com]
```

Custom HTTPS hosts must be exact. Insecure HTTP is accepted only for explicit localhost providers. Secret values never participate in normal configuration merging.
