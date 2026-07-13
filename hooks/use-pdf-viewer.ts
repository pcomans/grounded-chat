"use client";

import { useCallback, useMemo } from "react";
import useSWR from "swr";
import type { ChunkBbox } from "@/lib/db/schema";

export type PdfViewerState = {
  isVisible: boolean;
  documentId: string;
  documentTitle: string;
  page: number;
  bboxes: ChunkBbox[];
};

export const initialPdfViewerData: PdfViewerState = {
  bboxes: [],
  documentId: "",
  documentTitle: "",
  isVisible: false,
  page: 1,
};

export function usePdfViewer() {
  const { data: localState, mutate: setLocalState } = useSWR<PdfViewerState>(
    "pdf-viewer",
    null,
    { fallbackData: initialPdfViewerData }
  );

  const pdfViewer = useMemo(
    () => localState ?? initialPdfViewerData,
    [localState]
  );

  const setPdfViewer = useCallback(
    (
      updaterFn: PdfViewerState | ((current: PdfViewerState) => PdfViewerState)
    ) => {
      setLocalState((current) => {
        const currentState = current ?? initialPdfViewerData;
        return typeof updaterFn === "function"
          ? updaterFn(currentState)
          : updaterFn;
      });
    },
    [setLocalState]
  );

  return { pdfViewer, setPdfViewer };
}
