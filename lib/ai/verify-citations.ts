import "server-only";
import { generateObject } from "ai";
import { z } from "zod";
import { getLanguageModel } from "@/lib/ai/providers";
import {
  isLangSmithTracingEnabled,
  isProductionEnvironment,
} from "@/lib/constants";

// The second, in-context validation step (PRD §03 P1 / TDD §8). A retrieved
// chunk can be *relevant* yet not actually *support* the answer once you read
// the passages around it — that is the RAG failure mode this checks for. One
// batched call reviews the whole answer against every cited chunk read inside
// its neighborhood (the chunk plus its immediate neighbors), preserving
// cross-citation relationships.
//
// No fallback: any failure — model error, or a citation the model fails to
// judge — throws. We do not degrade or drop cards.
export type CitationVerdictStatus =
  | "supported"
  | "contradicted"
  | "not_enough_context";

export type CitationVerdict = {
  chunkId: string;
  status: CitationVerdictStatus;
  // One sentence, present only when status !== "supported".
  note?: string;
  // Verbatim spans of the cited chunk that are actually relevant to the answer
  // (empty when nothing is). The model selects them BY SEGMENT NUMBER (see
  // relevantSegments below), never by re-typing text, so these are guaranteed
  // exact slices of the chunk — OCR artifacts and whitespace can't break the
  // UI's substring match. The UI highlights these and centers the truncated
  // chunk on them.
  highlights?: string[];
};

export type CitationToVerify = {
  chunkId: string;
  // The inline [n] marker this citation carries in the answer text.
  marker: number;
  docTitle: string;
  page: number;
  // The exact cited chunk text (what the citation card displays).
  content: string;
  // The cited chunk plus its immediate neighbors, in reading order.
  contextWindow: string;
};

// Segments shorter than this are folded into the previous one, so numbering
// isn't polluted by OCR fragments like "1.2" or "Fig.".
const MIN_SEGMENT_CHARS = 24;
// Cap so a verdict can't turn the whole chunk into one giant highlight.
const MAX_HIGHLIGHTS = 4;

// The verifier runs on a fixed fast model, independent of the chat model.
// Judging citations against a fetched context window is mechanical: Haiku 4.5
// measures ~8s here vs ~44s for Sonnet 5, with identical verdicts — and it
// keeps the whole step comfortably inside the route's maxDuration budget.
const VERIFIER_MODEL_ID = "anthropic/claude-haiku-4.5";

type Segment = { start: number; end: number; text: string };

// Split a chunk into numbered, sentence-ish segments with offsets back into the
// original string. We reference these by number in the prompt and resolve the
// model's picks to exact substrings — no fuzzy quote matching, so OCR noise or
// whitespace in the source never costs us a highlight.
function splitIntoSegments(text: string): Segment[] {
  const bounds: Array<{ start: number; end: number }> = [];
  // Sentence end: . ! ? (or a closing quote after it) followed by whitespace
  // and something that looks like a new sentence start.
  const re = /[.!?]["”]?(?=\s+["“(]?[A-Z0-9])/g;
  let start = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const end = m.index + m[0].length;
    bounds.push({ end, start });
    let s = end;
    while (s < text.length && /\s/.test(text[s])) {
      s += 1;
    }
    start = s;
    re.lastIndex = start;
    m = re.exec(text);
  }
  if (start < text.length) {
    bounds.push({ end: text.length, start });
  }

  const merged: Array<{ start: number; end: number }> = [];
  for (const b of bounds) {
    const prev = merged.at(-1);
    if (prev && b.end - b.start < MIN_SEGMENT_CHARS) {
      prev.end = b.end;
    } else {
      merged.push({ ...b });
    }
  }
  return merged.map((b) => ({
    end: b.end,
    start: b.start,
    text: text.slice(b.start, b.end),
  }));
}

const verdictSchema = z.object({
  verdicts: z
    .array(
      z.object({
        chunkId: z
          .string()
          .describe("The chunkId of the citation being judged"),
        note: z
          .string()
          .optional()
          .describe(
            "One sentence explaining the verdict; include only when status is not 'supported'"
          ),
        relevantSegments: z
          .array(z.number().int())
          .describe(
            "The [n] segment numbers of THIS citation's cited chunk whose text is actually relevant to the answer's claim. Reference by number — do not retype the text. Empty array if no segment is genuinely relevant."
          ),
        status: z
          .enum(["supported", "contradicted", "not_enough_context"])
          .describe(
            "supported: the neighborhood supports the answer's use of this citation. contradicted: it conflicts with or materially qualifies that use. not_enough_context: the passage is relevant but does not actually establish the claim."
          ),
      })
    )
    .describe("Exactly one verdict per provided citation"),
});

function buildPrompt(
  answer: string,
  segmented: Array<{ citation: CitationToVerify; segments: Segment[] }>
): string {
  const blocks = segmented
    .map(({ citation: c, segments }) => {
      const numbered = segments
        .map((s, idx) => `[${idx + 1}] ${s.text.trim()}`)
        .join("\n");
      return `--- Citation [${c.marker}] (the answer's inline [${c.marker}] marker) ---
chunkId: ${c.chunkId}
Source: ${c.docTitle} (p. ${c.page})

Cited chunk, split into numbered segments:
${numbered}

The cited chunk read in its surrounding context (the passages before and after it):
"""
${c.contextWindow.trim()}
"""`;
    })
    .join("\n\n");

  return `You are a citation verifier for a retrieval-augmented answer about Ancient Egypt and Nubia. Each citation is labeled with the inline [n] marker it carries in the answer; judge whether the cited chunk — read in its surrounding context — actually supports the specific claim the answer makes at that [n] marker. A chunk can look relevant yet be unsupported or even contradicted once you read the passages around it.

For each citation return exactly one verdict:
- "supported": the surrounding context supports the answer's use of this citation.
- "contradicted": the surrounding context conflicts with, or materially qualifies, the answer's use of this citation.
- "not_enough_context": the passage is on-topic but does not, on its own, establish the specific claim the answer attributes to it.

Judge only the relationship between the answer and each citation's context. Do not use outside knowledge. Return a verdict for every citation, keyed by its chunkId. Add a one-sentence note only when the verdict is not "supported".

For each citation also return "relevantSegments": the [n] numbers of the cited chunk's segments whose text a reader should look at to see the support. Reference them by number only — never retype text. Choose the fewest that carry the relevance; empty array if none genuinely do.

Answer being verified:
"""
${answer.trim()}
"""

Citations:
${blocks}`;
}

/**
 * Runs the batched in-context verifier. One structured call reviews the answer
 * against every cited chunk read inside its neighborhood, preserving
 * cross-citation relationships (PRD §03 P1 / TDD §8).
 *
 * Throws on model failure or a citation the model fails to judge. No fallback.
 */
export async function verifyCitations({
  answer,
  citations,
}: {
  answer: string;
  citations: CitationToVerify[];
}): Promise<CitationVerdict[]> {
  if (citations.length === 0) {
    return [];
  }

  const segmented = citations.map((citation) => ({
    citation,
    segments: splitIntoSegments(citation.content),
  }));

  const { object } = await generateObject({
    model: getLanguageModel(VERIFIER_MODEL_ID),
    prompt: buildPrompt(answer, segmented),
    schema: verdictSchema,
    telemetry: {
      functionId: "verify-citations",
      isEnabled: isProductionEnvironment || isLangSmithTracingEnabled,
    },
  });

  const byId = new Map(object.verdicts.map((v) => [v.chunkId, v]));

  // Key verdicts back to the exact citations we asked about. Every citation
  // must be judged; a missing verdict is a hard error (we never invent one).
  return segmented.map(({ citation, segments }): CitationVerdict => {
    const { chunkId } = citation;
    const v = byId.get(chunkId);
    if (!v) {
      throw new Error(`Verifier returned no verdict for chunkId ${chunkId}.`);
    }

    // Resolve segment numbers (1-based) to their exact source text. Out-of-range
    // picks are dropped: a stray highlight index shouldn't sink verification —
    // highlights are informational, the verdict is the load-bearing output.
    const highlights = Array.from(new Set(v.relevantSegments))
      .map((n) => segments[n - 1]?.text.trim())
      .filter((t): t is string => Boolean(t))
      .slice(0, MAX_HIGHLIGHTS);

    return {
      chunkId,
      status: v.status,
      ...(v.status === "supported" ? {} : { note: v.note }),
      ...(highlights.length > 0 ? { highlights } : {}),
    };
  });
}
