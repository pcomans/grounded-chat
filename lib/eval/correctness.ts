import { gateway, generateText } from "ai";
import type { Example, Run } from "langsmith/schemas";

/**
 * LLM-as-judge answer-correctness evaluator.
 *
 * Runs entirely through the Vercel AI Gateway (single credential, AI_GATEWAY_API_KEY),
 * so no separate OpenAI key is needed. Uses plain text output + a VERDICT line rather
 * than structured output, so it works on any gateway model regardless of json-schema
 * support. Override the judge via EVAL_JUDGE_MODEL (a Vercel AI Gateway model id).
 */

const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? "openai/gpt-oss-120b";

export async function correctness(run: Run, example?: Example) {
  const question = String(example?.inputs?.question ?? "");
  const reference = String(example?.outputs?.reference_answer ?? "");
  const predicted = String(run.outputs?.answer ?? "");

  const { text } = await generateText({
    model: gateway.languageModel(JUDGE_MODEL),
    prompt: `You are grading whether a candidate answer is factually correct against a gold reference answer.

Question:
${question}

Gold reference answer:
${reference}

Candidate answer:
${predicted}

Mark it CORRECT only if the candidate conveys the same key fact(s) as the reference. Minor wording, rounding, or added-but-consistent detail is fine. A refusal, an "I don't know", a hedge with no committed answer, or any wrong/contradictory fact is INCORRECT.

Reply on the first line with exactly "VERDICT: CORRECT" or "VERDICT: INCORRECT", then one sentence of reasoning.`,
  });

  const isCorrect = /VERDICT:\s*CORRECT/i.test(text);

  return {
    comment: text.trim(),
    key: "correctness",
    score: isCorrect ? 1 : 0,
  };
}
