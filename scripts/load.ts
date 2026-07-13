/**
 * Embed corpus.jsonl chunks and upsert them into Postgres (docs/tdd-grounded-rag.md §6).
 *
 * Reads the JSONL produced by scripts/ingest.py, embeds each chunk's content with
 * cohere/embed-v4.0 via the Vercel AI Gateway (input_type=search_document), and
 * inserts documents + chunks into Neon.
 *
 * Resumable: a chunk is keyed by its content hash; chunks already present in the DB
 * are skipped, so a chunking tweak or a mid-run failure only re-embeds what changed.
 *
 * Run:  pnpm ingest:load                    # embed + load corpus.jsonl
 *       pnpm ingest:load --file other.jsonl # alternate input
 *       pnpm ingest:load --dry-run          # parse + report, no embeds, no writes
 */

import { readFileSync } from "node:fs";
import { embedMany, gateway } from "ai";
import { config } from "dotenv";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { EMBED_INPUT_TYPE, EMBEDDING_MODEL_ID } from "../lib/ai/embedding";
import {
  type ChunkBbox,
  corpusChunk as chunksTable,
  corpusDocument as documentsTable,
} from "../lib/db/schema";

config({ path: ".env.local" });

const EMBED_BATCH = 96; // chunks per gateway embedding request
const INSERT_BATCH = 500; // rows per DB insert

type DocRecord = {
  type: "document";
  id: string; // filename (natural key from the parser)
  title: string;
  author: string | null;
  year: number | null;
  filename: string;
  pageCount: number;
  fullText: string;
};

type ChunkRecord = {
  type: "chunk";
  documentId: string; // filename
  page: number;
  chunkIndex: number;
  content: string;
  charStart: number;
  charEnd: number;
  bboxes: ChunkBbox[];
  contentHash: string;
};

function parseArgs() {
  const argv = process.argv.slice(2);
  const file = argv.includes("--file")
    ? argv[argv.indexOf("--file") + 1]
    : "corpus.jsonl";
  return { dryRun: argv.includes("--dry-run"), file };
}

function readCorpus(file: string) {
  const docs: DocRecord[] = [];
  const chunks: ChunkRecord[] = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const rec = JSON.parse(line) as DocRecord | ChunkRecord;
    if (rec.type === "document") {
      docs.push(rec);
    } else {
      chunks.push(rec);
    }
  }
  return { chunks, docs };
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function main() {
  const { file, dryRun } = parseArgs();
  const { docs, chunks } = readCorpus(file);
  console.log(
    `Read ${docs.length} documents, ${chunks.length} chunks from ${file}`
  );

  if (dryRun) {
    console.log("--dry-run: no embeddings, no writes.");
    return;
  }

  if (!process.env.POSTGRES_URL) {
    throw new Error("POSTGRES_URL not set (expected in .env.local)");
  }

  const sql = postgres(process.env.POSTGRES_URL, { max: 1 });
  const db = drizzle(sql);

  try {
    // 1. Upsert documents by filename, mapping filename -> real uuid.
    const filenameToId = new Map<string, string>();
    for (const doc of docs) {
      const existing = await db
        .select({ id: documentsTable.id })
        .from(documentsTable)
        .where(inArray(documentsTable.filename, [doc.filename]));
      if (existing.length > 0) {
        filenameToId.set(doc.filename, existing[0].id);
        continue;
      }
      const [inserted] = await db
        .insert(documentsTable)
        .values({
          author: doc.author,
          filename: doc.filename,
          fullText: doc.fullText,
          pageCount: doc.pageCount,
          title: doc.title,
          year: doc.year,
        })
        .returning({ id: documentsTable.id });
      filenameToId.set(doc.filename, inserted.id);
    }

    // 2. Resumability: which content hashes are already loaded?
    const allHashes = chunks.map((c) => c.contentHash);
    const seen = new Set<string>();
    for (const batch of chunkArray(allHashes, 1000)) {
      const rows = await db
        .select({ contentHash: chunksTable.contentHash })
        .from(chunksTable)
        .where(inArray(chunksTable.contentHash, batch));
      for (const r of rows) {
        seen.add(r.contentHash);
      }
    }

    // Dedupe within this run too (defensive), then drop already-loaded chunks.
    const pending: ChunkRecord[] = [];
    const runSeen = new Set<string>();
    for (const c of chunks) {
      if (seen.has(c.contentHash) || runSeen.has(c.contentHash)) {
        continue;
      }
      runSeen.add(c.contentHash);
      pending.push(c);
    }
    console.log(
      `${seen.size} chunks already loaded; embedding ${pending.length} new chunks.`
    );

    // 3. Embed in batches, buffer rows, flush inserts.
    const model = gateway.textEmbeddingModel(EMBEDDING_MODEL_ID);
    let rowBuffer: (typeof chunksTable.$inferInsert)[] = [];
    let embedded = 0;

    const flush = async () => {
      if (rowBuffer.length === 0) {
        return;
      }
      for (const part of chunkArray(rowBuffer, INSERT_BATCH)) {
        await db.insert(chunksTable).values(part);
      }
      rowBuffer = [];
    };

    for (const batch of chunkArray(pending, EMBED_BATCH)) {
      const { embeddings } = await embedMany({
        model,
        providerOptions: { cohere: { inputType: EMBED_INPUT_TYPE.DOCUMENT } },
        values: batch.map((c) => c.content),
      });
      for (let i = 0; i < batch.length; i++) {
        const c = batch[i];
        const documentId = filenameToId.get(c.documentId);
        if (!documentId) {
          throw new Error(`no document row for ${c.documentId}`);
        }
        rowBuffer.push({
          bboxes: c.bboxes,
          charEnd: c.charEnd,
          charStart: c.charStart,
          chunkIndex: c.chunkIndex,
          content: c.content,
          contentHash: c.contentHash,
          documentId,
          embedding: embeddings[i],
          page: c.page,
        });
      }
      embedded += batch.length;
      if (rowBuffer.length >= INSERT_BATCH) {
        await flush();
      }
      process.stdout.write(`\r  embedded ${embedded}/${pending.length} chunks`);
    }
    await flush();
    process.stdout.write("\n");

    const [{ count }] = await sql`select count(*)::int as count from chunks`;
    console.log(`Done. chunks table now holds ${count} rows.`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("\nLoad failed:", err);
  process.exit(1);
});
