import { gateway, generateText } from "ai";
import { DEFAULT_CHAT_MODEL } from "../ai/models";
import { systemPrompt } from "../ai/prompts";

/**
 * Baseline eval target: reproduces the production agent's answer path without the
 * HTTP / auth / streaming stack, so a LangSmith evaluator can call it directly.
 *
 * In non-test env, `getLanguageModel(id)` reduces to `gateway.languageModel(id)`
 * (see lib/ai/providers.ts), so we hit the gateway directly with the same default
 * model and the same system prompt the route uses.
 *
 * The production route also exposes artifact/weather tools, but none of them fire
 * for factoid Q&A; the baseline uses the plain (no-tools) system prompt — the
 * no-context text the model actually sees when answering a question. This is the
 * Phase-0 floor: no retrieval, so we expect ~0 on the needles by construction.
 */

const EMPTY_HINTS = {
  city: undefined,
  country: undefined,
  latitude: undefined,
  longitude: undefined,
};

export async function runAgent(question: string): Promise<{ answer: string }> {
  const { text } = await generateText({
    model: gateway.languageModel(DEFAULT_CHAT_MODEL),
    prompt: question,
    system: systemPrompt({ requestHints: EMPTY_HINTS, supportsTools: false }),
  });

  return { answer: text };
}
