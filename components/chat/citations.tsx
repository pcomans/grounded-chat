"use client";

import { useCallback, useState } from "react";
import type { ResolvedCitation } from "@/lib/ai/tools/provide-citations";

function CitationCard({ citation }: { citation: ResolvedCitation }) {
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);
  const hasExcerpt = Boolean(citation.excerpt);
  const shownText =
    expanded || !hasExcerpt ? citation.content : citation.excerpt;

  return (
    <div className="rounded-2xl border border-border/30 bg-gradient-to-br from-secondary to-muted px-3.5 py-2.5 shadow-[var(--shadow-card)]">
      <div className="flex items-baseline gap-2 font-medium text-foreground">
        <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted-foreground/15 text-[11px] text-muted-foreground">
          {citation.marker}
        </span>
        <span className="truncate">{citation.docTitle}</span>
        <span className="shrink-0 text-muted-foreground text-xs">
          p. {citation.page}
        </span>
      </div>
      <p className="mt-1.5 text-muted-foreground leading-[1.55]">
        “{shownText?.trim()}”
      </p>
      {hasExcerpt && (
        <button
          className="mt-1 text-muted-foreground text-xs underline underline-offset-2 hover:text-foreground"
          onClick={toggleExpanded}
          type="button"
        >
          {expanded ? "Show excerpt only" : "Show full chunk"}
        </button>
      )}
    </div>
  );
}

export function Citations({ citations }: { citations: ResolvedCitation[] }) {
  if (citations.length === 0) {
    return null;
  }

  const sorted = [...citations].sort((a, b) => a.marker - b.marker);

  return (
    <div className="flex w-full flex-col gap-2 text-[13px]">
      <div className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Citations
      </div>
      <div className="flex flex-col gap-2">
        {sorted.map((citation) => (
          <CitationCard citation={citation} key={citation.chunkId} />
        ))}
      </div>
    </div>
  );
}
