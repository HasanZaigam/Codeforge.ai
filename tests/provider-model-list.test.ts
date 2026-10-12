import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  OpenAiProviderAdapter,
  isOpenAiChatModel,
  selectGoogleChatModels,
  selectOpenAiChatModels,
} from "../src/providers/provider-adapter.js";

// A trimmed copy of what a real OpenAI key's GET /v1/models returned in the reported incident: every
// modality mixed together, which the Settings dropdown showed verbatim (and alphabetically, so
// "babbage-002" became the default selection).
const OPENAI_MODELS = [
  { id: "babbage-002", created: 1692634615 },
  { id: "davinci-002", created: 1692634301 },
  { id: "chatgpt-image-latest", created: 1745000000 },
  { id: "text-embedding-3-small", created: 1705948997 },
  { id: "whisper-1", created: 1677532384 },
  { id: "tts-1-hd", created: 1699046015 },
  { id: "dall-e-3", created: 1698785189 },
  { id: "omni-moderation-latest", created: 1731689265 },
  { id: "gpt-4o-audio-preview", created: 1727460443 },
  { id: "gpt-4o-realtime-preview", created: 1727659998 },
  { id: "gpt-4o-mini-search-preview", created: 1741391161 },
  { id: "gpt-4o-transcribe", created: 1742068463 },
  { id: "gpt-3.5-turbo-instruct", created: 1692901427 },
  { id: "gpt-3.5-turbo", created: 1677610602 },
  { id: "gpt-4o", created: 1715367049 },
  { id: "gpt-4.1", created: 1744316542 },
  { id: "gpt-4o-mini", created: 1721172741 },
  { id: "ft:gpt-4o-mini-2024-07-18:personal::AGqLLP98", created: 1728000000 },
  { id: "ft:gpt-3.5-turbo-0125:personal::9VZMnUWK", created: 1717000000 },
];

describe("OpenAI model list", () => {
  test("keeps only chat models — drops embedding, audio, image, moderation, search and legacy completion models", () => {
    const models = selectOpenAiChatModels(OPENAI_MODELS);
    for (const dropped of [
      "babbage-002",
      "davinci-002",
      "chatgpt-image-latest",
      "text-embedding-3-small",
      "whisper-1",
      "tts-1-hd",
      "dall-e-3",
      "omni-moderation-latest",
      "gpt-4o-audio-preview",
      "gpt-4o-realtime-preview",
      "gpt-4o-mini-search-preview",
      "gpt-4o-transcribe",
      "gpt-3.5-turbo-instruct",
    ]) {
      assert.ok(!models.includes(dropped), `${dropped} should not be offered`);
    }
    assert.ok(models.includes("gpt-4.1"));
    assert.ok(models.includes("gpt-3.5-turbo"));
  });

  test("lists newest models first (so the default is a current model, never babbage-002), with fine-tunes after base models", () => {
    assert.deepEqual(selectOpenAiChatModels(OPENAI_MODELS), [
      "gpt-4.1",
      "gpt-4o-mini",
      "gpt-4o",
      "gpt-3.5-turbo",
      "ft:gpt-4o-mini-2024-07-18:personal::AGqLLP98",
      "ft:gpt-3.5-turbo-0125:personal::9VZMnUWK",
    ]);
  });

  test("a chat model the deny-list has never heard of still shows up", () => {
    assert.equal(isOpenAiChatModel("gpt-9-turbo"), true);
  });

  describe("validateCredentials", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    test("rejects a model the account has but that can't chat, with an actionable message", async () => {
      globalThis.fetch = (async () => new Response(JSON.stringify({ data: OPENAI_MODELS }), { status: 200 })) as typeof fetch;
      const result = await new OpenAiProviderAdapter().validateCredentials("sk-test", "babbage-002");
      assert.equal(result.valid, false);
      assert.match(result.error ?? "", /isn't a chat model/);
    });

    test("accepts a chat model the account has", async () => {
      globalThis.fetch = (async () => new Response(JSON.stringify({ data: OPENAI_MODELS }), { status: 200 })) as typeof fetch;
      const result = await new OpenAiProviderAdapter().validateCredentials("sk-test", "gpt-4.1");
      assert.deepEqual(result, { valid: true, error: null });
    });
  });
});

describe("Google model list", () => {
  test("keeps only text-generating models, Gemini stable versions first, newest first", () => {
    const models = selectGoogleChatModels([
      { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
      { name: "models/aqa", supportedGenerationMethods: ["generateAnswer"] },
      { name: "models/imagen-3.0-generate-002", supportedGenerationMethods: ["predict"] },
      { name: "models/gemini-2.5-flash-preview-tts", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-2.0-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-2.5-flash-preview-05-20", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemma-3-27b-it", supportedGenerationMethods: ["generateContent"] },
    ]);
    assert.deepEqual(models, ["gemini-2.5-pro", "gemini-2.0-flash", "gemini-2.5-flash-preview-05-20", "gemma-3-27b-it"]);
  });
});
