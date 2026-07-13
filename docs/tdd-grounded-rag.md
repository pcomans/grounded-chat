# TDD: Grounded RAG Agent with Verified Citations

**Author:** Philipp Comans
**Date:** 2026-07-13 (rev. after Codex build-review + ingest/searchCorpus build)
**Status:** Approved in planning session (Giuseppe, Brian). Revised post-review: verifier
promoted to P0; retrieval guaranteed by evals (not forced tool choice); embedding model
corrected to `cohere/embed-v4.0`. Ingest (§6) and `searchCorpus` (§7) are built.
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

Drizzle schema additions (`lib/db/schema.ts`), pgvector extension enabled. Exports are
`corpusDocument` / `corpusChunk` (table names `documents` / `chunks`) — named to avoid
collision with the template's existing artifacts `Document` table:

```
corpusDocument: id, title, author, year, filename, pageCount, fullText
corpusChunk:    id, documentId, page (pdf page index), chunkIndex,
                content (~300 words), charStart, charEnd (offsets into page text),
                contentHash (sha256, drives resumable loads),
                bboxes jsonb  -- [{page, x, y, w, h}] as % of page dims
                embedding vector(1536)
```

**The pointer is `(documentId, page, charStart–charEnd, bboxes[])`.**

- Char offsets drive the verifier's context expansion (slice ±1 page of `fullText`).
- Page index drives PDF deep links. ⚠️ **`page` is the 0-based *PDF index*, not the
  printed page** — front matter offsets them (in Smith 2003, PDF index 40 = printed
  "20"), so a naive "p. 29" citation is wrong. Fix tracked in
  [issue #3](https://github.com/pcomans/grounded-chat/issues/3): add `printedPageLabel`
  (from PyMuPDF `get_label()`, PDF-index fallback), backfillable without re-embedding.
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

## 6. Ingest pipeline — ✅ built (PR #1)

`scripts/ingest.py` (PyMuPDF, uv/PEP-723) → `corpus.jsonl` → `scripts/load.ts` (embed +
insert). pgvector + tables created by migration `0001`.

1. **Parse:** per page, `page.get_text("blocks")` returns text blocks *with native
   bounding rects* (text-layer read; no OCR/ML). Merge consecutive blocks into ~300-word
   chunks, small overlap, respecting page boundaries; carry block rects per chunk.
   Filter obvious junk (page numbers, running headers: short blocks at page edges).
2. **Embed:** **`cohere/embed-v4.0`** (1536-dim) via AI Gateway, batched ~96/request.
   ⚠️ **Divergence from the original plan:** not `text-embedding-3-small` — chosen for
   retrieval quality on this niche corpus. The model id is a single source of truth in
   `lib/ai/embedding.ts`, imported by both the loader and `searchCorpus` so query and
   document vector spaces cannot drift. Cohere is asymmetric: chunks embed as
   `search_document`, queries as `search_query`.
3. **Load:** upsert into Postgres. **Resumable:** skip chunks whose row already exists,
   keyed on content hash — a chunking tweak or mid-run failure only re-embeds what changed.

**Measured on this corpus (2026-07-13, M-series MacBook):** full parse with bboxes =
**~10s** for all 2,644 pages → **4,365 chunks** (the earlier 3,000–3,500 estimate was
low; overlap + page-boundary splits push it up). Embedding + load ≈ 2 min, one-time,
pennies. Verified: 7 docs / 4,365 chunks / 0 null embeddings; live cosine retrieval
returns relevant passages. Parsing is free to iterate; JSONL is the intermediate artifact
so chunking changes never force re-parsing decisions downstream.

Python is used only for this offline script (PyMuPDF is the best-in-class local
extractor and the corpus needs no cloud parsing service); everything online is
TypeScript.

## 7. Retrieval & answer generation — ✅ `searchCorpus` built (on `main`)

- One tool on the existing chat route: `searchCorpus(query)` → embed query → top-8 by
  cosine over pgvector. Brute-force scan, **no index** — ~4.4k rows makes HNSW pointless.
- No hybrid search, reranker, or multi-query rewriting in v0 (demo-invisible at this
  corpus size; cut for time).
- Tool result rows: `{chunkId, docTitle, page, content}`. System prompt requires inline
  markers `[1]`, `[2]` keyed to chunk ids and forbids uncited factual claims about the
  corpus domain.
- Citations render from streamed tool-call parts (template already streams these) — no
  new wire protocol.

**Retrieval is guaranteed by evals, not by forcing tool choice.** The chat route keeps
its other tools on automatic tool choice; the system prompt *instructs* the model to call
`searchCorpus` before answering corpus-domain questions, but nothing forces it.
Rationale: on this deliberately niche corpus, an answer that skips retrieval and leans on
parametric memory will get needle questions wrong, so the **lift eval (§9) fails** — that
is the signal we want to measure. **Rejected alternative:** hard-forcing first-step
`searchCorpus` (or a single-tool grounded route) — it would mask exactly the behaviour
the eval exists to catch, and removes the model's judgement on non-corpus turns.

- **Out-of-domain refusal:** apply a cosine-similarity floor in `searchCorpus`; if the
  top hit is below it, return no results so the agent abstains instead of citing junk for
  questions the corpus can't answer.

## 8. Verification agent (P0 — headline differentiator)

**Promoted to P0 (was P1).** The TDD's title promises *verified* citations, so a shipped
v0 without the verifier wouldn't deliver its headline — this is the differentiator, not a
nice-to-have. Funded by dropping eval automation and the PDF viewer to stretch (§9, §11).

After the answer completes, one call receives: the answer, each cited chunk, and each
chunk's expanded window (±1 page from `fullText`). Output schema, per citation:

```
verdict: supported | contradicted | not_enough_context
note: one sentence, only when verdict ≠ supported
```

Categorical verdicts by design — no percentage confidence scores. Rendered as a compact
per-citation badge under the answer.

## 9. Evals

Needle-in-haystack from the corpus. **Start with 3–5 hand-picked needles**, not an
automated mining pipeline — the lift eval is now load-bearing (it's what guarantees
retrieval actually happens, §7), so it must exist early and be trustworthy; a tiny
hand-curated set gets there faster than building the miner. **Automated mining is
deprioritized to stretch** (funds the P0 verifier).

1. **Hand-pick (P0):** 3–5 *non-obvious* facts a corpus-blind model gets wrong — verified
   by actually asking one — each with its known source chunk id.
2. **Test lift (P0):** same questions to the full agent vs. a corpus-blind agent; grade
   answers against the reference. This is the "prove it works" demo *and* the retrieval
   guarantee.
3. **Test recall (P1):** fact → question → does `searchCorpus` retrieve the source chunk
   (known id) in top-k? Report recall@k.
4. **Mine at scale (stretch):** agent reads sampled chunks, auto-extracts needles with
   the no-context filter, to grow the set beyond the hand-picked few.

Dataset: `evals/needles.jsonl` (`question, referenceAnswer, sourceChunkId`).

## 10. UI

- P0: citation chips `[1]` → popover with book, page, chunk excerpt. Chip must render
  from the message's own tool output (a stable `citationKey` per result), not by prompt
  correlation alone — otherwise `[1]` and the cited chunk can drift.
- P0: verifier badges (✓ supported / ✗ contradicted / ? insufficient) — promoted with
  the verifier (§8); the badges *are* the visible headline.
- Stretch: side-by-side PDF viewer — PDFs served statically, pdf.js-based viewer
  (`@react-pdf-viewer/highlight` or `react-pdf` + absolutely-positioned overlay divs),
  citation click → page with bbox highlight. Percentage-based bboxes drop directly into
  these APIs; pdf.js range-loads large files.
- Visual brief: match the existing template UI.

## 11. Build plan

| # | Work stream | Priority | Notes |
|---|---|---|---|
| 1 | Ingest (parse → embed → load) | P0 | ✅ **done** (PR #1) |
| 3 | `searchCorpus` tool + citation schema | P0 | ✅ **done** (on `main`) |
| 2 | Hand-pick 3–5 eval needles + lift run | P0 | load-bearing: guarantees retrieval (§7) |
| 4 | Citation chips in UI (stable `citationKey`) | P0 | demo-critical |
| 6 | **Verifier agent + badges** | **P0** | **the headline — promoted from P1** |
| 5 | Recall@k eval run | P1 | |
| 7 | PDF viewer with bbox highlights | stretch | |
| 8 | Automated needle mining | stretch | grow the eval set past the hand-picked few |
| 9 | `printedPageLabel` for correct page citations | follow-up | [issue #3](https://github.com/pcomans/grounded-chat/issues/3) |

Revised cut line: the four remaining P0s (eval needles + lift, citation chips, verifier
badges) are the vertical slice that delivers the "verified citations" headline; **PDF
viewer and eval-mining automation are the funded cuts.** Quality gates: lint + typecheck
on every commit (pre-commit hook already enforces); test coverage for core
chunking/citation logic only; no red-green TDD (timebox).

## 12. Risks

| Risk | Mitigation |
|---|---|
| Header/footer junk pollutes chunks | edge-position heuristic at parse; re-parse is ~10s |
| Citation schema drift from model | structured output schema; retry on validation fail |
| `[1]` marker drifts from cited chunk | render chips from tool output via stable `citationKey`, not prompt correlation (§10) |
| Wrong page number in citations | `page` is PDF index ≠ printed page; add `printedPageLabel` ([issue #3](https://github.com/pcomans/grounded-chat/issues/3)) |
| Agent answers without retrieving | lift eval catches it (§7); we deliberately don't force tool choice |
| Out-of-domain question cites junk | cosine floor in `searchCorpus` → abstain (§7) |
| Verifier adds too much latency | single batched call; runs after answer streams |
| ~~Embedding model id stale~~ resolved | `cohere/embed-v4.0`, single source of truth in `lib/ai/embedding.ts` (§6) |
| Timebox overrun | priority order above; **viewer + eval-mining are the cuts, verifier is P0** |
