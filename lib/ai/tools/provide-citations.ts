import { tool } from "ai";
import { z } from "zod";
import type { CorpusSearchResult } from "./search-corpus";

export type ResolvedCitation = CorpusSearchResult & { marker: number };

export const createProvideCitations = ({
  getChunk,
  onCitations,
}: {
  getChunk: (chunkId: string) => CorpusSearchResult | undefined;
  // Fires with the validated citations so the route can run the P1 verifier
  // over exactly what will render — mirrors searchCorpus's onResults.
  onCitations?: (citations: ResolvedCitation[]) => void;
}) =>
  tool({
    description:
      "Report the citations used in your answer. Call this exactly once, after writing the answer text, with one entry per inline [n] marker you used. Only cite chunkIds returned by searchCorpus — never invent one. Skip this call entirely if the answer made no corpus claims.",
    execute: ({ citations }): { citations: ResolvedCitation[] } => {
      // Server-side validation: drop any chunkId that wasn't actually
      // retrieved this turn, so a hallucinated id can never render (PRD:
      // "no citation ID is invented").
      const resolved = citations
        .map(({ marker, chunkId }) => {
          const chunk = getChunk(chunkId);
          return chunk ? { ...chunk, marker } : null;
        })
        .filter((c): c is ResolvedCitation => c !== null);

      onCitations?.(resolved);

      return { citations: resolved };
    },
    inputSchema: z.object({
      citations: z
        .array(
          z.object({
            chunkId: z
              .string()
              .describe("The chunkId exactly as returned by searchCorpus"),
            marker: z
              .number()
              .int()
              .describe("The [n] marker number used inline in the answer"),
          })
        )
        .describe("One entry per inline citation marker used in the answer"),
    }),
  });
