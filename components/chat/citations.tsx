import {
  CheckCircle2,
  CircleHelp,
  CircleOff,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import type { ResolvedCitation } from "@/lib/ai/tools/provide-citations";
import type {
  CitationVerdict,
  CitationVerdictStatus,
} from "@/lib/ai/verify-citations";

type StatusStyle = {
  label: string;
  Icon: typeof CheckCircle2;
  className: string;
};

// Text label is the source of truth; the icon is supplemental and hidden from
// assistive tech (PRD §04 accessibility + AT-8: never rely on icon/color alone).
const STATUS_STYLES: Record<CitationVerdictStatus, StatusStyle> = {
  contradicted: {
    className: "text-amber-600 dark:text-amber-500",
    Icon: TriangleAlert,
    label: "Contradicted in broader context",
  },
  not_enough_context: {
    className: "text-muted-foreground",
    Icon: CircleHelp,
    label: "Not enough context to verify",
  },
  supported: {
    className: "text-emerald-600 dark:text-emerald-500",
    Icon: CheckCircle2,
    label: "Supported in broader context",
  },
  verification_unavailable: {
    className: "text-muted-foreground",
    Icon: CircleOff,
    label: "Verification unavailable",
  },
};

function VerdictRow({ verdict }: { verdict?: CitationVerdict }) {
  // No verdict part yet → the batched verifier is still running.
  if (!verdict) {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-muted-foreground text-xs">
        <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
        <span>Verifying broader context…</span>
      </div>
    );
  }

  const style = STATUS_STYLES[verdict.status];

  return (
    <div className={`mt-2 flex flex-col gap-0.5 text-xs ${style.className}`}>
      <div className="flex items-center gap-1.5 font-medium">
        <style.Icon aria-hidden="true" className="size-3.5 shrink-0" />
        <span>{style.label}</span>
      </div>
      {verdict.status !== "supported" && verdict.note ? (
        <p className="pl-5 text-muted-foreground leading-snug">
          {verdict.note}
        </p>
      ) : null}
    </div>
  );
}

export function Citations({
  citations,
  verdicts,
}: {
  citations: ResolvedCitation[];
  verdicts?: CitationVerdict[];
}) {
  if (citations.length === 0) {
    return null;
  }

  const sorted = [...citations].sort((a, b) => a.marker - b.marker);
  const verdictByChunk = new Map(
    (verdicts ?? []).map((v) => [v.chunkId, v] as const)
  );

  // Overall warning when every citation is contradicted (PRD AT-5). Only once
  // verdicts have arrived and at least one citation exists.
  const allContradicted =
    verdicts !== undefined &&
    verdicts.length > 0 &&
    sorted.every(
      (c) => verdictByChunk.get(c.chunkId)?.status === "contradicted"
    );

  return (
    <div className="flex w-full flex-col gap-2 text-[13px]">
      <div className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        Citations
      </div>
      {allContradicted ? (
        <div className="flex items-center gap-1.5 rounded-lg border border-amber-600/30 bg-amber-500/10 px-3 py-2 text-amber-700 text-xs dark:text-amber-400">
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
          <span className="font-medium">
            Every citation is contradicted by its broader context — treat this
            answer with caution.
          </span>
        </div>
      ) : null}
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
            <VerdictRow verdict={verdictByChunk.get(citation.chunkId)} />
          </div>
        ))}
      </div>
    </div>
  );
}
