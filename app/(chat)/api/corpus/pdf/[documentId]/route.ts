import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { auth } from "@/app/(auth)/auth";
import { getCorpusDocumentById } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";

// Gitignored local folder — PDFs are copyrighted source material and are
// never committed. Override with CORPUS_DIR if they live elsewhere.
const CORPUS_DIR = path.resolve(
  process.env.CORPUS_DIR ?? path.join(process.cwd(), "corpus-pdfs")
);

const RANGE_PATTERN = /bytes=(\d+)-(\d*)/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ documentId: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return new ChatbotError("unauthorized:document").toResponse();
  }

  const { documentId } = await params;
  const doc = await getCorpusDocumentById({ id: documentId });
  if (!doc) {
    return new ChatbotError("not_found:document").toResponse();
  }

  const filePath = path.resolve(CORPUS_DIR, doc.filename);
  if (!filePath.startsWith(CORPUS_DIR)) {
    // Path traversal guard — a filename with ../ segments can't happen from
    // ingest, but never trust a resolved path outside CORPUS_DIR.
    return new ChatbotError("not_found:document").toResponse();
  }

  let fileSize: number;
  try {
    fileSize = statSync(filePath).size;
  } catch {
    return new ChatbotError("not_found:document").toResponse();
  }

  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
    "Content-Type": "application/pdf",
  });

  const range = request.headers.get("range");
  const match = range ? RANGE_PATTERN.exec(range) : null;

  if (match) {
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : fileSize - 1;

    headers.set("Content-Length", String(end - start + 1));
    headers.set("Content-Range", `bytes ${start}-${end}/${fileSize}`);

    const stream = createReadStream(filePath, { end, start });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers,
      status: 206,
    });
  }

  headers.set("Content-Length", String(fileSize));
  const stream = createReadStream(filePath);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers,
    status: 200,
  });
}
