import { Client } from "langsmith";
import { isLangSmithTracingEnabled } from "@/lib/constants";

// A single shared LangSmith client so the telemetry integration
// (`instrumentation.ts`) and request handlers flush the same batch queue.
//
// The LangSmith SDK sends runs in the background on a timer. In serverless
// (Vercel), the function is frozen the moment the response stream closes, which
// is usually *before* that background send fires — so traces silently never
// arrive. Handlers must therefore flush pending batches with `flushLangSmith()`
// (via `after()`) before returning. Null when tracing is disabled.
export const langsmithClient = isLangSmithTracingEnabled ? new Client() : null;

/**
 * Flush any pending LangSmith trace batches. Safe to call when tracing is off
 * (resolves immediately). Call inside `after()` so it runs once the response
 * has finished streaming and all telemetry runs have been enqueued.
 */
export function flushLangSmith(): Promise<void> {
  return langsmithClient?.awaitPendingTraceBatches() ?? Promise.resolve();
}
