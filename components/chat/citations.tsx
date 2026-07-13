import type { ResolvedCitation } from "@/lib/ai/tools/provide-citations";

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
          <div
            className="rounded-2xl border border-border/30 bg-gradient-to-br from-secondary to-muted px-3.5 py-2.5 shadow-[var(--shadow-card)]"
            key={citation.chunkId}
          >
            <div className="flex items-baseline gap-2 font-medium text-foreground">
              <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted-foreground/15 text-[11px] text-muted-foreground">
                {citation.marker}
              </span>
              <span className="truncate">{citation.docTitle}</span>
              <span className="shrink-0 text-muted-foreground text-xs">
                p. {citation.page}
              </span>
            </div>
            <p className="mt-1.5 line-clamp-3 text-muted-foreground leading-[1.55]">
              “{citation.content.trim()}”
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
