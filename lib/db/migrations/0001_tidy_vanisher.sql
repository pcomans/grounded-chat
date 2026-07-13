-- Grounded RAG corpus tables (docs/tdd-grounded-rag.md §5).
-- The base template's 0000_initial.sql has no drizzle snapshot, so `db:generate`
-- re-emits the whole schema; this migration is trimmed to only the new objects.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "documents" (
	"author" text,
	"filename" text NOT NULL,
	"fullText" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pageCount" integer NOT NULL,
	"title" text NOT NULL,
	"year" integer
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"bboxes" jsonb NOT NULL,
	"charEnd" integer NOT NULL,
	"charStart" integer NOT NULL,
	"chunkIndex" integer NOT NULL,
	"content" text NOT NULL,
	"contentHash" varchar(64) NOT NULL,
	"documentId" uuid NOT NULL,
	"embedding" vector(1536),
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"page" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_documentId_documents_id_fk" FOREIGN KEY ("documentId") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunks_document_idx" ON "chunks" USING btree ("documentId");--> statement-breakpoint
CREATE INDEX "chunks_content_hash_idx" ON "chunks" USING btree ("contentHash");
