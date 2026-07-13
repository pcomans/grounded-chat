// Single source of truth for the corpus embedding model. Both the ingest loader
// (scripts/load.ts) and the retrieval side (searchCorpus) MUST use this so query
// vectors live in the same space as the stored chunk vectors.
//
// The loaded corpus was verified (2026-07-13) to be cohere/embed-v4.0 at 1536
// dims, NOT the TDD's text-embedding-3-small — re-embedding a chunk and comparing
// against its stored vector is the way to re-check this if retrieval similarities
// crater. If you change this id, re-run the full ingest (the vectors won't match
// across models) and confirm the dimension still fits the schema's vector(1536).
export const EMBEDDING_MODEL_ID = "cohere/embed-v4.0";

// Dimension of the embedding vectors, matching chunks.embedding vector(1536).
export const EMBEDDING_DIMENSIONS = 1536;

// Cohere embed v4 is asymmetric: documents are embedded as "search_document",
// queries as "search_query". Ingest uses DOCUMENT; the retrieval tool uses QUERY.
export const EMBED_INPUT_TYPE = {
  DOCUMENT: "search_document",
  QUERY: "search_query",
} as const;
