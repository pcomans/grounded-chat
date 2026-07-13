# /// script
# requires-python = ">=3.11"
# dependencies = ["pymupdf==1.28.0"]
# ///
"""Parse the Egyptology/Nubiology corpus into corpus.jsonl.

See docs/tdd-grounded-rag.md §6. Text-layer read only (no OCR/ML): per page we
take `page.get_text("blocks")` — text blocks with their native bounding rects —
merge consecutive blocks into ~300-word chunks (respecting page boundaries,
small overlap), carry the block rects per chunk, and filter obvious running
headers / footers / page numbers by edge position.

Output is one JSON object per line: interleaved `document` records (one per book)
followed by that book's `chunk` records. Char offsets on each chunk index into
the *page* text, and the verifier later expands context from the document's
concatenated page text.

Run:  uv run scripts/ingest.py            # all in-scope books -> corpus.jsonl
      uv run scripts/ingest.py --limit 1  # smoke test: first book only
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

import fitz  # PyMuPDF

# --- Corpus manifest -------------------------------------------------------
# The 7 in-scope books (clean extractable text layers). The 3 image-only /
# negligible-text PDFs in the source folder are deliberately excluded — see
# TDD §3. Metadata is curated here so citations render cleanly ("Smith 2003").

CORPUS_DIR = Path("/Users/philipp/Books/Egypt and Nubia GC")

BOOKS: list[dict] = [
    {
        "filename": "Nubia Oxford Handbook Emberling & Williams 2021.pdf",
        "title": "The Oxford Handbook of Ancient Nubia",
        "author": "Emberling & Williams (eds.)",
        "year": 2021,
    },
    {
        "filename": "Klemm 2013 Gold Mining Egypt Nubia.pdf",
        "title": "Gold and Gold Mining in Ancient Egypt and Nubia",
        "author": "Klemm & Klemm",
        "year": 2013,
    },
    {
        "filename": "Smith 2003 - Nubia, Wretched Kush.pdf",
        "title": "Wretched Kush: Ethnic Identities and Boundaries in Egypt's Nubian Empire",
        "author": "Stuart Tyson Smith",
        "year": 2003,
    },
    {
        "filename": "Redford 2004 Nubia - The Black Experience of Ancient Egypt.pdf",
        "title": "From Slave to Pharaoh: The Black Experience of Ancient Egypt",
        "author": "Donald B. Redford",
        "year": 2004,
    },
    {
        "filename": "Darnell 2021 Egypt & Desert.pdf",
        "title": "Egypt and the Desert",
        "author": "John Coleman Darnell",
        "year": 2021,
    },
    {
        "filename": "Manzo 2022 AE in African Context.pdf",
        "title": "Ancient Egypt in its African Context",
        "author": "Andrea Manzo",
        "year": 2022,
    },
    {
        "filename": "Vogel 2010 - Fortifications of Ancient Egypt.pdf",
        "title": "The Fortifications of Ancient Egypt 3000–1780 BC",
        "author": "Carola Vogel",
        "year": 2010,
    },
]

# --- Tuning knobs ----------------------------------------------------------

TARGET_WORDS = 300  # ~300-word chunks (TDD §5)
OVERLAP_WORDS = 40  # small overlap so a sentence split across chunks survives
EDGE_MARGIN = 0.07  # top/bottom 7% of page height = header/footer zone
MAX_HEADER_WORDS = 8  # short blocks in the edge zone are junk (page #s, headers)
MIN_CHUNK_WORDS = 15  # drop tiny trailing fragments

WORD_RE = re.compile(r"\S+")


@dataclass
class BBox:
    """Block rect normalized to percentages of page dimensions (TDD §5)."""

    page: int
    x: float
    y: float
    w: float
    h: float


@dataclass
class Chunk:
    documentId: str  # filename stands in as a stable id until load time
    page: int
    chunkIndex: int
    content: str
    charStart: int
    charEnd: int
    bboxes: list[dict]
    contentHash: str
    type: str = field(default="chunk")


def is_junk_block(text: str, rect: fitz.Rect, page_h: float) -> bool:
    """Running header / footer / page-number heuristic: a short block sitting in
    the top or bottom edge zone of the page."""
    words = len(WORD_RE.findall(text))
    if words == 0:
        return True
    in_top = rect.y0 < page_h * EDGE_MARGIN
    in_bottom = rect.y1 > page_h * (1 - EDGE_MARGIN)
    if (in_top or in_bottom) and words <= MAX_HEADER_WORDS:
        return True
    # Pure page numbers / roman numerals anywhere.
    if words <= 3 and re.fullmatch(r"[\divxlcIVXLC.\-–—\s]+", text.strip()):
        return True
    return False


def normalize_bbox(rect: fitz.Rect, page_no: int, page_w: float, page_h: float) -> dict:
    return asdict(
        BBox(
            page=page_no,
            x=round(100 * rect.x0 / page_w, 3),
            y=round(100 * rect.y0 / page_h, 3),
            w=round(100 * (rect.x1 - rect.x0) / page_w, 3),
            h=round(100 * (rect.y1 - rect.y0) / page_h, 3),
        )
    )


def content_hash(filename: str, page: int, text: str) -> str:
    # Keyed on (book, page, content) so identical boilerplate on different pages
    # still yields distinct chunks, and re-runs are idempotent.
    h = hashlib.sha256()
    h.update(filename.encode())
    h.update(str(page).encode())
    h.update(text.encode())
    return h.hexdigest()


def chunk_page(
    filename: str,
    page_no: int,
    blocks: list[tuple],
    page_w: float,
    page_h: float,
    start_index: int,
) -> tuple[list[Chunk], str]:
    """Merge a page's text blocks into ~TARGET_WORDS chunks.

    Returns the page's chunks and the page's full concatenated text (used for
    the document-level fullText and to keep char offsets meaningful per page).
    """
    # Keep only real text blocks (block type 0), in reading order.
    text_blocks = [
        (b[4], fitz.Rect(b[:4]))
        for b in blocks
        if b[6] == 0 and not is_junk_block(b[4], fitz.Rect(b[:4]), page_h)
    ]

    page_text_parts: list[str] = []
    chunks: list[Chunk] = []
    idx = start_index

    # Accumulate blocks until we cross the word target, then flush a chunk.
    buf_text: list[str] = []
    buf_rects: list[fitz.Rect] = []
    buf_words = 0
    # Running char cursor into the page's concatenated text.
    page_char_cursor = 0
    chunk_char_start = 0

    def flush(carry_overlap: bool) -> None:
        nonlocal idx, buf_text, buf_rects, buf_words, chunk_char_start
        if not buf_text:
            return
        content = "\n".join(buf_text).strip()
        if len(WORD_RE.findall(content)) < MIN_CHUNK_WORDS:
            # Too small to stand alone; fold forward by keeping the buffer.
            return
        char_start = chunk_char_start
        char_end = char_start + len(content)
        bboxes = [normalize_bbox(r, page_no, page_w, page_h) for r in buf_rects]
        chunks.append(
            Chunk(
                documentId=filename,
                page=page_no,
                chunkIndex=idx,
                content=content,
                charStart=char_start,
                charEnd=char_end,
                bboxes=bboxes,
                contentHash=content_hash(filename, page_no, content),
            )
        )
        idx += 1
        if carry_overlap and OVERLAP_WORDS > 0:
            tail = WORD_RE.findall(content)[-OVERLAP_WORDS:]
            overlap = " ".join(tail)
            buf_text = [overlap]
            buf_rects = buf_rects[-1:]  # associate overlap with last block's rect
            buf_words = len(tail)
            chunk_char_start = char_end - len(overlap)
        else:
            buf_text = []
            buf_rects = []
            buf_words = 0

    for text, rect in text_blocks:
        text = text.strip()
        if not text:
            continue
        # Track this block's position in the page's full text.
        if page_text_parts:
            page_text_parts.append("\n")
            page_char_cursor += 1
        block_start = page_char_cursor
        page_text_parts.append(text)
        page_char_cursor += len(text)

        if not buf_text:
            chunk_char_start = block_start
        buf_text.append(text)
        buf_rects.append(rect)
        buf_words += len(WORD_RE.findall(text))

        if buf_words >= TARGET_WORDS:
            flush(carry_overlap=True)

    flush(carry_overlap=False)

    page_text = "".join(page_text_parts)
    return chunks, page_text


def process_book(book: dict) -> tuple[dict, list[Chunk]]:
    path = CORPUS_DIR / book["filename"]
    if not path.exists():
        raise FileNotFoundError(f"missing corpus file: {path}")

    doc = fitz.open(path)
    all_chunks: list[Chunk] = []
    page_texts: list[str] = []
    next_index = 0

    for page_no in range(doc.page_count):
        page = doc.load_page(page_no)
        rect = page.rect
        blocks = page.get_text("blocks")
        chunks, page_text = chunk_page(
            book["filename"], page_no, blocks, rect.width, rect.height, next_index
        )
        if chunks:
            next_index = chunks[-1].chunkIndex + 1
        all_chunks.extend(chunks)
        page_texts.append(page_text)

    page_count = doc.page_count
    doc.close()

    document = {
        "type": "document",
        "id": book["filename"],  # stable natural key; real uuid assigned at load
        "title": book["title"],
        "author": book["author"],
        "year": book["year"],
        "filename": book["filename"],
        "pageCount": page_count,
        # \f (form feed) separates pages so the loader can rebuild per-page text
        # and the verifier can slice ±1 page.
        "fullText": "\f".join(page_texts),
    }
    return document, all_chunks


def main() -> int:
    ap = argparse.ArgumentParser(description="Parse corpus PDFs into corpus.jsonl")
    ap.add_argument("--limit", type=int, default=0, help="process only first N books")
    ap.add_argument("--out", default="corpus.jsonl", help="output JSONL path")
    args = ap.parse_args()

    books = BOOKS[: args.limit] if args.limit else BOOKS
    out_path = Path(args.out)

    total_chunks = 0
    with out_path.open("w", encoding="utf-8") as f:
        for book in books:
            document, chunks = process_book(book)
            f.write(json.dumps(document, ensure_ascii=False) + "\n")
            for ch in chunks:
                f.write(json.dumps(asdict(ch), ensure_ascii=False) + "\n")
            total_chunks += len(chunks)
            print(
                f"  {book['filename'][:48]:<48} "
                f"{document['pageCount']:>5} pages  {len(chunks):>5} chunks",
                file=sys.stderr,
            )

    print(
        f"\n{len(books)} books -> {total_chunks} chunks -> {out_path}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
