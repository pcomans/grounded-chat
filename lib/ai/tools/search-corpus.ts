import { embed, gateway, tool } from "ai";
import { z } from "zod";
import { searchChunksByEmbedding } from "@/lib/db/queries";

// Must match the model that embedded the corpus chunks. The loaded corpus was
// verified (2026-07-13) to be cohere/embed-v4.0 at 1536 dims, not the TDD's
// text-embedding-3-small — re-embedding a chunk and comparing against its
// stored vector is the way to re-check this if retrieval similarities crater.
export const EMBEDDING_MODEL_ID = "cohere/embed-v4.0";

const TOP_K = 8;

export async function embedQuery(query: string): Promise<number[]> {
  const { embedding } = await embed({
    model: gateway.textEmbeddingModel(EMBEDDING_MODEL_ID),
    // Cohere embeddings are asymmetric: corpus chunks are embedded as
    // documents, so search queries must use the query input type.
    providerOptions: { cohere: { inputType: "search_query" } },
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

export const searchCorpus = tool({
  description:
    "Search a curated corpus of scholarly books about Ancient Egypt and Nubia (history, archaeology, gold mining, fortifications, Kerma and Kush). Returns the most relevant text chunks with their source book and page. Use this before answering any factual question about the corpus domain.",
  execute: async ({ query }): Promise<CorpusSearchResult[]> => {
    const embedding = await embedQuery(query);
    const rows = await searchChunksByEmbedding({ embedding, limit: TOP_K });

    return rows.map(({ chunkId, docTitle, page, content }) => ({
      chunkId,
      content,
      docTitle,
      page,
    }));
  },
  inputSchema: z.object({
    query: z
      .string()
      .describe(
        "Natural-language search query, e.g. a question or key phrase about Ancient Egypt or Nubia"
      ),
  }),
});
