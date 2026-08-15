import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { initializeProject } from "../src/commands/init.js";
import { loadEffectiveConfig } from "../src/config/load.js";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.js";
import { AnthropicMessagesProvider } from "../src/providers/anthropic.js";
import type { CaptureEnvelope } from "../src/connectors/types.js";

const capture: CaptureEnvelope = { sourceId: "SRC-TEST", externalKey: "1", canonicalUrl: "https://example.com/1", title: "Runtime update",
  summary: "The runtime adds an evidence checkpoint.", capturedAt: "2026-08-11T00:00:00Z", contentHash: "abc", evidenceClass: "primary", analysisText: "Full transient evidence includes implementation boundaries." };
function analysis() { const score = { value: 4, reason: "Primary evidence." }; return { title: "Runtime adds evidence checkpoint", summary: capture.summary, whyItMatters: "Improves auditability.", domain: "Agent", claims: ["Adds an evidence checkpoint"], claimEvidence: [{ claimIndex: 0, excerpt: "Full transient evidence includes implementation boundaries." }], knowledgePotential: { reusableQuestion: true, mechanismIncrement: true, durableWithoutVersion: true, reason: "Reusable" }, scores: { authority: score, evidence: score, relevance: score, impact: score, novelty: score, recency: score, actionability: score }, exclusions: [] }; }

async function providerContext(model: string, secretName: string, secretValue: string) {
  const root = await mkdtemp(path.join(tmpdir(), `briefwright-${model}-`)); process.env[secretName] = secretValue;
  const configPath = await initializeProject({ directory: root, yes: true, model }); const config = await loadEffectiveConfig(configPath);
  return { config, context: { interests: config.interests, domains: config.policy.domains, prompt: config.prompts, provider: config.provider, projectRoot: root } };
}

describe("generic provider protocols", () => {
  it.each([[
    "openai", "OPENAI_API_KEY", "openai-test", "https://api.openai.com/v1/chat/completions",
  ], ["gemini", "GEMINI_API_KEY", "gemini-test", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"],
  ["qwen", "DASHSCOPE_API_KEY", "qwen-test", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"]])("uses one reviewed OpenAI-compatible protocol for %s", async (model, env, secret, endpoint) => {
    const { config, context } = await providerContext(model, env, secret); let requested = ""; let usage: Record<string, unknown> = {};
    const provider = new OpenAICompatibleProvider(config.provider.id, async (url, init) => { requested = String(url); expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${secret}`);
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> }; const user = JSON.parse(body.messages.find((message) => message.role === "user")!.content) as { source: { evidenceText: string; summary: string } };
      expect(user.source).toMatchObject({ evidenceText: "Full transient evidence includes implementation boundaries.", summary: capture.summary });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysis()) } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }), { status: 200 }); });
    await expect(provider.analyze(capture, { ...context, observeUsage: (value) => { usage = value; } })).resolves.toMatchObject({ domain: "Agent" }); expect(requested).toBe(endpoint);
    expect(usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
  });

  it("uses Anthropic Messages with the Anthropic credential header", async () => {
    const { context } = await providerContext("anthropic", "ANTHROPIC_API_KEY", "anthropic-test"); let requested = ""; let usage: Record<string, unknown> = {};
    const provider = new AnthropicMessagesProvider(async (url, init) => { requested = String(url); expect(new Headers(init?.headers).get("x-api-key")).toBe("anthropic-test"); return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(analysis()) }], usage: { input_tokens: 11, output_tokens: 22 } }), { status: 200 }); });
    await expect(provider.analyze(capture, { ...context, observeUsage: (value) => { usage = value; } })).resolves.toMatchObject({ domain: "Agent" }); expect(requested).toBe("https://api.anthropic.com/v1/messages");
    expect(usage).toEqual({ inputTokens: 11, outputTokens: 22, totalTokens: 33 });
  });

  it("supports keyless localhost OpenAI-compatible providers without putting a secret in the body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "briefwright-ollama-")); const configPath = await initializeProject({ directory: root, yes: true, model: "ollama" }); const config = await loadEffectiveConfig(configPath); let authorization: string | null = "unexpected";
    const provider = new OpenAICompatibleProvider("ollama", async (_url, init) => { authorization = new Headers(init?.headers).get("authorization"); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysis()) } }] }), { status: 200 }); });
    await provider.analyze(capture, { interests: config.interests, domains: config.policy.domains, prompt: config.prompts, provider: config.provider, projectRoot: root }); expect(authorization).toBeNull();
  });

  it("does not retry a non-retryable provider 4xx", async () => {
    const { context } = await providerContext("openai", "OPENAI_API_KEY", "openai-test"); let calls = 0;
    const provider = new OpenAICompatibleProvider("openai", async () => { calls += 1; return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }); });
    await expect(provider.analyze(capture, context)).rejects.toThrow("bad request"); expect(calls).toBe(1);
  });
});
