import { embed, gateway, tool } from "ai";
import { z } from "zod";
import { EMBED_INPUT_TYPE, EMBEDDING_MODEL_ID } from "@/lib/ai/embedding";
import { searchChunksByEmbedding } from "@/lib/db/queries";

const TOP_K = 8;

export async function embedQuery(query: string): Promise<number[]> {
  const { embedding } = await embed({
    model: gateway.textEmbeddingModel(EMBEDDING_MODEL_ID),
    // Cohere embeddings are asymmetric: corpus chunks are embedded as
    // documents, so search queries must use the query input type.
    providerOptions: { cohere: { inputType: EMBED_INPUT_TYPE.QUERY } },
    value: query,
  });
  return embedding;
}

export type CorpusSearchResult = {
  chunkId: string;
  docTitle: string;
  page: number;
  content: string;
};

export const createSearchCorpus = ({
  onResults,
}: {
  onResults: (results: CorpusSearchResult[]) => void;
}) =>
  tool({
    description:
      "Search a curated corpus of scholarly books about Ancient Egypt and Nubia (history, archaeology, gold mining, fortifications, Kerma and Kush). Returns the most relevant text chunks with their source book and page. Use this before answering any factual question about the corpus domain.",
    execute: async ({ query }): Promise<CorpusSearchResult[]> => {
      const embedding = await embedQuery(query);
      const rows = await searchChunksByEmbedding({ embedding, limit: TOP_K });
      const results = rows.map(({ chunkId, docTitle, page, content }) => ({
        chunkId,
        content,
        docTitle,
        page,
      }));

      onResults(results);
      return results;
    },
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "Natural-language search query, e.g. a question or key phrase about Ancient Egypt or Nubia"
        ),
    }),
  });
