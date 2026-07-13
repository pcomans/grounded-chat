"use client";

import {
  CheckCircle2,
  CircleHelp,
  CircleOff,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import type { ResolvedCitation } from "@/lib/ai/tools/provide-citations";
import type {
  CitationVerdict,
  CitationVerdictStatus,
} from "@/lib/ai/verify-citations";

// Roughly 3–4 lines at the card's 13px type — the collapsed excerpt window.
const WINDOW_CHARS = 280;
// How far we'll walk to snap a window edge to a word boundary.
const SNAP_MARGIN = 25;

type Segment = { text: string; mark: boolean };
type WindowView = {
  segments: Segment[];
  truncStart: boolean;
  truncEnd: boolean;
};

type StatusStyle = {
  label: string;
  Icon: typeof CheckCircle2;
  className: string;
  markClassName: string;
};

// Text label is the source of truth; icon/color are supplemental (PRD §04
// accessibility + AT-8: never rely on icon or color alone).
const STATUS_STYLES: Record<CitationVerdictStatus, StatusStyle> = {
  contradicted: {
    className: "text-amber-600 dark:text-amber-500",
    Icon: TriangleAlert,
    label: "Contradicted in broader context",
    markClassName: "bg-amber-500/25",
  },
  not_enough_context: {
    className: "text-muted-foreground",
    Icon: CircleHelp,
    label: "Not enough context to verify",
    markClassName: "bg-muted-foreground/20",
  },
  supported: {
    className: "text-emerald-600 dark:text-emerald-500",
    Icon: CheckCircle2,
    label: "Supported in broader context",
    markClassName: "bg-emerald-500/20",
  },
  verification_unavailable: {
    className: "text-muted-foreground",
    Icon: CircleOff,
    label: "Verification unavailable",
    markClassName: "bg-primary/15",
  },
};

// Neutral highlight used before a verdict lands (highlight sourced from the
// answer model's excerpt) or when there is no verdict.
const PENDING_MARK_CLASS = "bg-primary/15";

function locateHighlights(
  content: string,
  highlights: string[]
): [number, number][] {
  const ranges: [number, number][] = [];
  for (const raw of highlights) {
    const needle = raw.trim();
    if (!needle) {
      continue;
    }
    const idx = content.indexOf(needle);
    if (idx >= 0) {
      ranges.push([idx, idx + needle.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push([r[0], r[1]]);
    }
  }
  return merged;
}

function snapStart(content: string, i: number): number {
  let j = i;
  const limit = Math.max(0, i - SNAP_MARGIN);
  while (j > limit && !/\s/.test(content[j - 1])) {
    j -= 1;
  }
  return j;
}

function snapEnd(content: string, i: number): number {
  let j = i;
  const limit = Math.min(content.length, i + SNAP_MARGIN);
  while (j < limit && !/\s/.test(content[j])) {
    j += 1;
  }
  return j;
}

// Build a display window over `content`. When collapsed, the window is centered
// on the located highlight span(s) so the relevant text is always visible with
// surrounding context; when expanded, the whole chunk is shown. Highlights are
// marked in both modes.
function buildWindow(
  content: string,
  highlights: string[],
  expanded: boolean
): WindowView {
  const ranges = locateHighlights(content, highlights);

  let winStart = 0;
  let winEnd = content.length;

  if (!expanded && content.length > WINDOW_CHARS) {
    if (ranges.length === 0) {
      winEnd = WINDOW_CHARS;
    } else {
      const [[hs]] = ranges;
      const he = ranges.at(-1)?.[1] ?? hs;
      const span = he - hs;
      if (span >= WINDOW_CHARS) {
        winStart = hs;
        winEnd = Math.min(content.length, hs + WINDOW_CHARS);
      } else {
        const budget = WINDOW_CHARS - span;
        let left = hs - Math.floor(budget / 2);
        let right = he + Math.ceil(budget / 2);
        if (left < 0) {
          right -= left;
          left = 0;
        }
        if (right > content.length) {
          left -= right - content.length;
          right = content.length;
        }
        winStart = Math.max(0, left);
        winEnd = Math.min(content.length, right);
      }
      winStart = snapStart(content, winStart);
      winEnd = snapEnd(content, winEnd);
    }
  }

  const segments: Segment[] = [];
  let cursor = winStart;
  for (const [rs, re] of ranges) {
    const s = Math.max(rs, winStart);
    const e = Math.min(re, winEnd);
    if (e <= winStart || s >= winEnd) {
      continue;
    }
    if (s > cursor) {
      segments.push({ mark: false, text: content.slice(cursor, s) });
    }
    segments.push({ mark: true, text: content.slice(s, e) });
    cursor = e;
  }
  if (cursor < winEnd) {
    segments.push({ mark: false, text: content.slice(cursor, winEnd) });
  }

  return {
    segments,
    truncEnd: winEnd < content.length,
    truncStart: winStart > 0,
  };
}

function HighlightedExcerpt({
  view,
  markClassName,
}: {
  view: WindowView;
  markClassName: string;
}) {
  const nodes: ReactNode[] = [];
  view.segments.forEach((seg, i) => {
    if (seg.mark) {
      nodes.push(
        <mark
          className={`rounded-[3px] px-0.5 text-foreground ${markClassName}`}
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
          key={`m-${i}`}
        >
          {seg.text}
        </mark>
      );
    } else {
      nodes.push(
        // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
        <span key={`t-${i}`}>{seg.text}</span>
      );
    }
  });

  return (
    <p className="mt-1.5 text-muted-foreground leading-[1.55]">
      “{view.truncStart ? "… " : ""}
      {nodes}
      {view.truncEnd ? " …" : ""}”
    </p>
  );
}

function VerdictRow({ verdict }: { verdict?: CitationVerdict }) {
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

function CitationCard({
  citation,
  verdict,
  onOpen,
}: {
  citation: ResolvedCitation;
  verdict?: CitationVerdict;
  onOpen: (citation: ResolvedCitation) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const handleOpen = useCallback(() => onOpen(citation), [onOpen, citation]);
  const toggleExpanded = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setExpanded((v) => !v);
  }, []);

  // Prefer the verifier's context-checked highlights; before the verdict lands
  // fall back to the answer model's excerpt so the relevant span is marked
  // immediately (PRD §04: "only if they ARE relevant").
  const highlights = useMemo(() => {
    if (verdict?.highlights && verdict.highlights.length > 0) {
      return verdict.highlights;
    }
    return citation.excerpt ? [citation.excerpt] : [];
  }, [verdict?.highlights, citation.excerpt]);

  const collapsed = useMemo(
    () => buildWindow(citation.content, highlights, false),
    [citation.content, highlights]
  );
  const view = useMemo(
    () =>
      expanded ? buildWindow(citation.content, highlights, true) : collapsed,
    [expanded, collapsed, citation.content, highlights]
  );
  const canExpand = collapsed.truncStart || collapsed.truncEnd;
  const markClassName = verdict
    ? STATUS_STYLES[verdict.status].markClassName
    : PENDING_MARK_CLASS;

  return (
    <div className="rounded-2xl border border-border/30 bg-gradient-to-br from-secondary to-muted px-3.5 py-2.5 shadow-[var(--shadow-card)]">
      <button
        className="w-full text-left transition-colors hover:text-foreground"
        onClick={handleOpen}
        type="button"
      >
        <div className="flex items-baseline gap-2 font-medium text-foreground">
          <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted-foreground/15 text-[11px] text-muted-foreground">
            {citation.marker}
          </span>
          <span className="truncate">{citation.docTitle}</span>
          <span className="shrink-0 text-muted-foreground text-xs">
            {/* citation.page is PyMuPDF's 0-indexed page number (ingest.py) */}
            p. {citation.page + 1}
          </span>
        </div>
        <HighlightedExcerpt markClassName={markClassName} view={view} />
      </button>
      {canExpand ? (
        <button
          className="mt-1 text-muted-foreground text-xs underline underline-offset-2 hover:text-foreground"
          onClick={toggleExpanded}
          type="button"
        >
          {expanded ? "Show less" : "Show full chunk"}
        </button>
      ) : null}
      <VerdictRow verdict={verdict} />
    </div>
  );
}

export function Citations({
  citations,
  onOpen,
  verdicts,
}: {
  citations: ResolvedCitation[];
  onOpen: (citation: ResolvedCitation) => void;
  verdicts?: CitationVerdict[];
}) {
  if (citations.length === 0) {
    return null;
  }

  const sorted = [...citations].sort((a, b) => a.marker - b.marker);
  const verdictByChunk = new Map(
    (verdicts ?? []).map((v) => [v.chunkId, v] as const)
  );

  // Overall warning when every citation is contradicted (PRD AT-5), once
  // verdicts have arrived.
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
          <CitationCard
            citation={citation}
            key={citation.chunkId}
            onOpen={onOpen}
            verdict={verdictByChunk.get(citation.chunkId)}
          />
        ))}
      </div>
    </div>
  );
}
