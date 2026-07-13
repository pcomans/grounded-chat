# TDD: Grounded RAG Agent with Verified Citations

**Author:** Philipp Comans
**Date:** 2026-07-13
**Status:** Approved in planning session (Giuseppe, Brian) — subject to change during build
**Timebox:** ~2 hours of build time

## 1. Summary

A RAG chat agent over a corpus of Egyptology/Nubiology books that (a) answers with
inline citations pointing to exact pages and regions of the source PDFs, and (b) runs a
secondary verification agent that judges whether each cited chunk actually supports the
answer *in its broader document context* — addressing the core RAG failure mode where a
chunk is a misleading excerpt of its surroundings.

Base: this repo (Vercel AI chatbot template — Next.js App Router, AI SDK, Drizzle +
Postgres, existing chat UI).

## 2. Problem

Chunk-level retrieval breaks the link between evidence and source:

1. **Citation gap** — answers assembled from chunks can't point users at where a claim
   lives in the original document.
2. **Context gap** — a chunk can appear to support a claim while its surrounding text
   qualifies or contradicts it (chunking artifact). Chunk-level citation checks can't
   catch this; document-level grounding can.

## 3. Corpus (measured)

Source: `/Users/philipp/Books/Egypt and Nubia GC` — 12 PDFs, triaged 2026-07-13.

**In scope — 7 books, ~947k words, 2,644 pages, clean extractable text layers:**

| Book | Pages | Words |
|---|---|---|
| Nubia Oxford Handbook (Emberling & Williams 2021) | 1,217 | 483k |
| Klemm, Gold Mining Egypt Nubia (2013) | 664 | 199k |
| Smith, Wretched Kush (2003) | 252 | 88k |
| Redford, Black Experience of Ancient Egypt (2004) | 231 | 77k |
| Darnell, Egypt & Desert (2021) | 110 | 41k |
| Manzo, AE in African Context (2022) | 102 | 38k |
| Vogel, Fortifications of Ancient Egypt (2010) | 68 | 22k |

**Out of scope:** Baines & Malek, Fletcher Jones 2018, Friedman 2002 (image-only scans,
no OCR layer — verified zero extractable text on sampled page ranges); the two Abu Simbel
guidebooks (negligible text). OCR does not fit the timebox.

This corpus is deliberately niche: specialist facts (Kerma-period toponyms, gold-mine
geology, fortress architecture) are weakly represented in model training data, so
retrieval demonstrably adds value and evals can distinguish grounded answers from
parametric knowledge.

## 4. Architecture

```
┌────────┐   ┌───────────────────────┐   ┌─────────────────┐
│ Chat UI │──▶│ Next.js chat route     │──▶│ Vercel AI Gateway│
│ (template)│ │  answer agent          │   │  (LLM + embeddings)
└────────┘   │  └─ tool: searchCorpus │   └─────────────────┘
      ▲      │  verifier agent (pass 2)│
      │      └───────────┬────────────┘
 citations +             │ top-k cosine
 verdicts    ┌───────────▼────────────┐
             │ Postgres + pgvector     │
             │  documents / chunks     │
             └───────────▲────────────┘
                         │ one-time load
             ┌───────────┴────────────┐
             │ Ingest (offline)        │
             │ PyMuPDF → JSONL →       │
             │ embed → insert          │
             └────────────────────────┘
```

Two-step workflow (not free-form sub-agents): **answer agent** retrieves and drafts with
citations; **verifier agent** receives all cited chunks + expanded context windows in a
single call and returns per-citation verdicts. Batched verification is deliberate —
chunk synergy matters (multiple chunks jointly supporting a claim), and one call keeps
latency and cost bounded.

## 5. Data model

Drizzle schema additions (`lib/db/schema.ts`), pgvector extension enabled:

```
documents: id, title, author, year, filename, pageCount, fullText
chunks:    id, documentId, page (pdf page index), chunkIndex,
           content (~300 words), charStart, charEnd (offsets into page text),
           bboxes jsonb  -- [{page, x, y, w, h}] as % of page dims
           embedding vector(1536)
```

**The pointer is `(documentId, page, charStart–charEnd, bboxes[])`.**

- Char offsets drive the verifier's context expansion (slice ±1 page of `fullText`).
- Page index drives human-readable citations ("Smith 2003, p. 29") and PDF deep links.
- Bounding boxes drive visual highlighting; normalized to percentages at ingest so the
  frontend never handles PDF point coordinates. Bboxes are presentational only — no
  critical-path feature depends on them.

Decision: store a **pointer, not a second "larger chunk."** Context is expanded at read
time from `fullText`, so the verifier chooses its own window size and nothing is stored
twice.

### Where the database lives

The corpus (and all app tables) live in a **single Neon Serverless Postgres** database,
provisioned through the **Vercel Marketplace** so one connection string is shared by the
app and the ingest scripts — no separate DB to keep in sync.

| | |
|---|---|
| Provider | Neon (Serverless Postgres) via Vercel Marketplace |
| Vercel project | `gc-chatbot` (team `philippcomans-gmailcoms-projects`) |
| Neon resource | `gc-chatbot-db` (Neon project `twilight-heart-95710476`) |
| Database / region | `neondb`, `us-east-1` |
| Extensions | `pgvector` (enabled by migration `0001`) |
| Console | Vercel dashboard → Storage → `gc-chatbot-db` (Neon SSO) |

Provisioned with `vercel integration add neon` (one-time marketplace terms acceptance in
the browser). Connection env vars (`POSTGRES_URL`, `DATABASE_URL`, `PG*`) are injected by
Vercel into all three environments (production / preview / development) and pulled locally
with `vercel env pull` → `.env.local` (gitignored). Scripts and Drizzle read
`POSTGRES_URL` from `.env.local`; **no connection string is committed.** To reconnect a
fresh checkout: `vercel link --project gc-chatbot && vercel env pull .env.local`.

## 6. Ingest pipeline

`scripts/ingest.py` (PyMuPDF) → `corpus.jsonl` → `scripts/load.ts` (embed + insert).

1. **Parse:** per page, `page.get_text("blocks")` returns text blocks *with native
   bounding rects* (text-layer read; no OCR/ML). Merge consecutive blocks into ~300-word
   chunks, small overlap, respecting page boundaries; carry block rects per chunk.
   Filter obvious junk (page numbers, running headers: short blocks at page edges).
2. **Embed:** `text-embedding-3-small` via AI Gateway (confirm model id against the live
   gateway model list at build time), batched ~100/request.
3. **Load:** upsert into Postgres. **Resumable:** skip chunks whose embedding already
   exists, keyed on content hash — a chunking tweak or mid-run failure only re-embeds
   what changed.

**Measured on this corpus (2026-07-13, M-series MacBook):** full parse with bboxes =
**7.9s** for all 2,644 pages / 15,261 blocks. Expected ~3,000–3,500 chunks; embedding
run ≈ 2–4 min, one-time, pennies. Parsing is free to iterate; JSONL is the intermediate
artifact so chunking changes never force re-parsing decisions downstream.

Python is used only for this offline script (PyMuPDF is the best-in-class local
extractor and the corpus needs no cloud parsing service); everything online is
TypeScript.

## 7. Retrieval & answer generation

- One tool on the existing chat route: `searchCorpus(query)` → embed query → top-8 by
  cosine over pgvector. Brute-force scan, **no index** — ~3.5k rows makes HNSW pointless.
- No hybrid search, reranker, or multi-query rewriting in v0 (demo-invisible at this
  corpus size; cut for time).
- Tool result rows: `{chunkId, docTitle, page, content}`. System prompt requires inline
  markers `[1]`, `[2]` keyed to chunk ids and forbids uncited factual claims about the
  corpus domain.
- Citations render from streamed tool-call parts (template already streams these) — no
  new wire protocol.

## 8. Verification agent (P1)

After the answer completes, one call receives: the answer, each cited chunk, and each
chunk's expanded window (±1 page from `fullText`). Output schema, per citation:

```
verdict: supported | contradicted | not_enough_context
note: one sentence, only when verdict ≠ supported
```

Categorical verdicts by design — no percentage confidence scores. Rendered as a compact
per-citation badge under the answer.

## 9. Evals

Needle-in-haystack, mined from the corpus itself:

1. **Mine:** agent reads sampled chunks, extracts *non-obvious* facts (filter: a
   no-context model cannot answer them — verified by actually asking one).
2. **Test recall:** fact → question → does `searchCorpus` retrieve the source chunk
   (known id) in top-k? Report recall@k.
3. **Test lift:** same questions to the full agent vs. a corpus-blind agent; grade
   answers against the reference. This is the "prove it works" demo.

Dataset: `evals/needles.jsonl` (`question, referenceAnswer, sourceChunkId`). Mining
starts first (parallel work stream — needs only the JSONL, not the app).

## 10. UI

- P0: citation chips `[1]` → popover with book, page, chunk excerpt.
- P1: verifier badges (✓ supported / ✗ contradicted / ? insufficient).
- Stretch: side-by-side PDF viewer — PDFs served statically, pdf.js-based viewer
  (`@react-pdf-viewer/highlight` or `react-pdf` + absolutely-positioned overlay divs),
  citation click → page with bbox highlight. Percentage-based bboxes drop directly into
  these APIs; pdf.js range-loads large files.
- Visual brief: match the existing template UI.

## 11. Build plan

| # | Work stream | Priority | Notes |
|---|---|---|---|
| 1 | Ingest (parse → embed → load) | P0 | starts immediately; runs while building #3 |
| 2 | Needle mining for evals | P0 | parallel from t=0; needs only JSONL |
| 3 | `searchCorpus` tool + citation schema | P0 | |
| 4 | Citation chips in UI | P0 | demo-critical |
| 5 | Recall + lift eval runs | P1 | the "prove it" moment |
| 6 | Verifier agent + badges | P1 | drop first if behind |
| 7 | PDF viewer with bbox highlights | stretch | |

Cut line per planning session: **evals vs. UI polish — pick one** if time forces it.
Quality gates: lint + typecheck on every commit (pre-commit hook already enforces);
test coverage for core chunking/citation logic only; no red-green TDD (timebox).

## 12. Risks

| Risk | Mitigation |
|---|---|
| Header/footer junk pollutes chunks | edge-position heuristic at parse; re-parse is 8s |
| Citation schema drift from model | structured output schema; retry on validation fail |
| Verifier adds too much latency | single batched call; runs after answer streams |
| Embedding model id stale | check live gateway model list before wiring |
| Timebox overrun | priority order above; verifier is first drop, viewer second |
