import { tool } from "ai";
import { z } from "zod";
import type { RetrievedChunk } from "./search-corpus";

export type ResolvedCitation = RetrievedChunk & {
  marker: number;
  excerpt: string | undefined;
};

export const createProvideCitations = ({
  getChunk,
}: {
  getChunk: (chunkId: string) => RetrievedChunk | undefined;
}) =>
  tool({
    description:
      "Report the citations used in your answer. Call this exactly once, after writing the answer text, with one entry per inline [n] marker you used. Only cite chunkIds returned by searchCorpus — never invent one. Skip this call entirely if the answer made no corpus claims.",
    execute: ({ citations }): { citations: ResolvedCitation[] } => {
      // Server-side validation: drop any chunkId that wasn't actually
      // retrieved this turn, so a hallucinated id can never render (PRD:
      // "no citation ID is invented"). Also drop any excerpt that isn't an
      // exact substring of the chunk, so a paraphrased/hallucinated quote
      // never renders as if it were the source text.
      const resolved = citations
        .map(({ marker, chunkId, excerpt }) => {
          const chunk = getChunk(chunkId);
          if (!chunk) {
            return null;
          }
          const verifiedExcerpt =
            excerpt && chunk.content.includes(excerpt) ? excerpt : undefined;
          return { ...chunk, excerpt: verifiedExcerpt, marker };
        })
        .filter((c): c is ResolvedCitation => c !== null);

      return { citations: resolved };
    },
    inputSchema: z.object({
      citations: z
        .array(
          z.object({
            chunkId: z
              .string()
              .describe("The chunkId exactly as returned by searchCorpus"),
            excerpt: z
              .string()
              .describe(
                "The exact verbatim sentence (or short span) copied character-for-character from the chunk's content that most directly supports the claim at this marker. Do not paraphrase or summarize — copy it exactly as it appears in the chunk."
              ),
            marker: z
              .number()
              .int()
              .describe("The [n] marker number used inline in the answer"),
          })
        )
        .describe("One entry per inline citation marker used in the answer"),
    }),
  });
