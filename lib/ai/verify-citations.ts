import { generateObject } from "ai";
import { z } from "zod";
import { getLanguageModel } from "@/lib/ai/providers";
import {
  isLangSmithTracingEnabled,
  isProductionEnvironment,
} from "@/lib/constants";

// The second, in-context validation step (PRD §03 P1 / TDD §8). A retrieved
// chunk can be *relevant* yet not actually *support* the answer once you read
// the surrounding page — that is the RAG failure mode this checks for.
//
// Three model verdicts; `verification_unavailable` is never returned by the
// model — the caller assigns it when the whole verification call fails
// (PRD §03 P1 requirement 4).
export type CitationVerdictStatus =
  | "supported"
  | "contradicted"
  | "not_enough_context"
  | "verification_unavailable";

export type CitationVerdict = {
  chunkId: string;
  status: CitationVerdictStatus;
  // One sentence, present only when status !== "supported".
  note?: string;
  // Verbatim spans of the cited chunk that are actually relevant to the answer,
  // validated as exact substrings of the chunk (empty when nothing is
  // relevant). The UI highlights these and centers the truncated chunk on them.
  highlights?: string[];
};

// Cap so a verifier can't return the whole chunk as one "highlight".
const MAX_HIGHLIGHTS = 4;

export type CitationToVerify = {
  chunkId: string;
  docTitle: string;
  page: number;
  excerpt: string;
  contextWindow: string;
};

const verdictSchema = z.object({
  verdicts: z
    .array(
      z.object({
        chunkId: z
          .string()
          .describe("The chunkId of the citation being judged"),
        highlights: z
          .array(z.string())
          .describe(
            "The specific verbatim span(s) copied character-for-character from THIS citation's cited excerpt that are actually relevant to the answer's claim. Copy exactly as they appear — do not paraphrase. Return an empty array if no part of the excerpt is genuinely relevant."
          ),
        note: z
          .string()
          .optional()
          .describe(
            "One sentence explaining the verdict; include only when status is not 'supported'"
          ),
        status: z
          .enum(["supported", "contradicted", "not_enough_context"])
          .describe(
            "supported: the broader context supports the answer's use of this citation. contradicted: the context conflicts with or materially qualifies that use. not_enough_context: the passage is relevant but does not actually establish the claim."
          ),
      })
    )
    .describe("Exactly one verdict per provided citation"),
});

function buildPrompt(answer: string, citations: CitationToVerify[]): string {
  const blocks = citations
    .map(
      (c, i) => `--- Citation ${i + 1} ---
chunkId: ${c.chunkId}
Source: ${c.docTitle} (p. ${c.page})

Cited excerpt (the exact chunk shown to the user):
"""
${c.excerpt.trim()}
"""

Broader document context around that excerpt:
"""
${c.contextWindow.trim()}
"""`
    )
    .join("\n\n");

  return `You are a citation verifier for a retrieval-augmented answer about Ancient Egypt and Nubia. Your job is to judge, for each citation, whether the cited passage — read in its broader document context — actually supports how the answer uses it.

For each citation return exactly one verdict:
- "supported": the broader context supports the answer's use of this citation.
- "contradicted": the broader context conflicts with, or materially qualifies, the answer's use of this citation.
- "not_enough_context": the passage is on-topic but does not, on its own, establish the specific claim the answer attributes to it.

Judge only the relationship between the answer and each source's broader context. Do not use outside knowledge. Return a verdict for every citation, keyed by its chunkId. Add a one-sentence note only when the verdict is not "supported".

For each citation, also return "highlights": the exact verbatim span(s) from that citation's cited excerpt (copied character-for-character, not paraphrased) that are actually relevant to the answer's claim. Prefer the shortest spans that carry the relevance. If no part of the excerpt is genuinely relevant, return an empty array.

Answer being verified:
"""
${answer.trim()}
"""

Citations:
${blocks}`;
}

/**
 * Runs the batched in-context verifier. One structured call reviews the answer
 * against every cited chunk plus its surrounding context, preserving
 * cross-citation relationships (PRD §03: "A batched review preserves
 * cross-citation relationships").
 *
 * Throws on model/transport failure; the caller assigns
 * `verification_unavailable` for the whole set (PRD §03 P1 requirement 4).
 */
export async function verifyCitations({
  answer,
  citations,
  modelId,
}: {
  answer: string;
  citations: CitationToVerify[];
  modelId: string;
}): Promise<CitationVerdict[]> {
  if (citations.length === 0) {
    return [];
  }

  const { object } = await generateObject({
    model: getLanguageModel(modelId),
    prompt: buildPrompt(answer, citations),
    schema: verdictSchema,
    telemetry: {
      functionId: "verify-citations",
      isEnabled: isProductionEnvironment || isLangSmithTracingEnabled,
    },
  });

  const byId = new Map(object.verdicts.map((v) => [v.chunkId, v]));

  // Key verdicts back to the exact citations we asked about. If the model
  // omits one, fall back to not_enough_context — we never upgrade an
  // unjudged citation to "supported".
  return citations.map((citation) => {
    const { chunkId } = citation;
    const v = byId.get(chunkId);
    if (!v) {
      return {
        chunkId,
        note: "The verifier returned no verdict for this citation.",
        status: "not_enough_context" as const,
      };
    }
    // Keep only highlights that are exact substrings of the cited chunk, so a
    // paraphrased or hallucinated span can never render as source text (same
    // guard as provideCitations' excerpt validation).
    const highlights = Array.from(new Set(v.highlights ?? []))
      .map((h) => h.trim())
      .filter((h) => h.length > 0 && citation.excerpt.includes(h))
      .slice(0, MAX_HIGHLIGHTS);

    return {
      chunkId,
      ...(v.status === "supported" ? {} : { note: v.note }),
      ...(highlights.length > 0 ? { highlights } : {}),
      status: v.status,
    };
  });
}
