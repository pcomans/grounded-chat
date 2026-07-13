"use client";

import { useCallback, useEffect, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { initialPdfViewerData, usePdfViewer } from "@/hooks/use-pdf-viewer";
import { CrossIcon } from "./icons";

// Pinned to match the installed pdfjs-dist version (5.4.296). Copied into
// public/ once at setup time — see package.json's pdfjs-dist dependency.
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

const MIN_PAGE_WIDTH = 200;
const PAGE_PADDING = 32;

export function PdfViewer() {
  const { pdfViewer, setPdfViewer } = usePdfViewer();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [pageWidth, setPageWidth] = useState(0);

  useEffect(() => {
    if (!container) {
      return;
    }
    const updateWidth = () => setPageWidth(container.clientWidth);
    updateWidth();
    window.addEventListener("resize", updateWidth);
    return () => window.removeEventListener("resize", updateWidth);
  }, [container]);

  const handleClose = useCallback(() => {
    setPdfViewer(initialPdfViewerData);
  }, [setPdfViewer]);

  if (!pdfViewer.isVisible) {
    return (
      <div
        className="h-dvh w-0 shrink-0 overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
        data-testid="pdf-viewer"
      />
    );
  }

  const bboxesForPage = pdfViewer.bboxes.filter(
    (bbox) => bbox.page === pdfViewer.page
  );

  return (
    <div
      className="flex h-dvh w-[45%] shrink-0 flex-col overflow-hidden border-l border-border/50 bg-sidebar transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
      data-testid="pdf-viewer"
    >
      <div className="flex h-[calc(3.5rem+1px)] shrink-0 items-center justify-between border-b border-border/50 px-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="truncate font-semibold text-sm leading-tight tracking-tight">
            {pdfViewer.documentTitle}
          </div>
          <div className="text-muted-foreground text-xs">
            Page {pdfViewer.page + 1}
          </div>
        </div>
        <button
          aria-label="Close PDF viewer"
          className="group flex size-8 shrink-0 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-all duration-150 hover:border-border hover:bg-muted hover:text-foreground active:scale-95"
          onClick={handleClose}
          type="button"
        >
          <CrossIcon size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4" ref={setContainer}>
        <div className="relative mx-auto w-fit">
          <Document
            error={
              <div className="max-w-xs p-8 text-muted-foreground text-sm">
                Couldn't load this PDF.
              </div>
            }
            file={`/api/corpus/pdf/${pdfViewer.documentId}`}
            loading={
              <div className="p-8 text-muted-foreground text-sm">
                Loading PDF…
              </div>
            }
          >
            <Page
              // documents.page (and bboxes[].page) are PyMuPDF's 0-indexed
              // page numbers from ingest.py; react-pdf's pageNumber is
              // 1-indexed.
              pageNumber={pdfViewer.page + 1}
              renderAnnotationLayer={false}
              renderTextLayer={false}
              width={Math.max(pageWidth - PAGE_PADDING, MIN_PAGE_WIDTH)}
            />
          </Document>
          {bboxesForPage.map((bbox) => (
            <div
              className="pointer-events-none absolute rounded-sm bg-yellow-300/40 ring-2 ring-yellow-500"
              key={`${bbox.x}-${bbox.y}-${bbox.w}-${bbox.h}`}
              style={{
                height: `${bbox.h}%`,
                left: `${bbox.x}%`,
                top: `${bbox.y}%`,
                width: `${bbox.w}%`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
