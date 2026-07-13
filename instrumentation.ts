import { OpenTelemetry } from "@ai-sdk/otel";
import { registerOTel } from "@vercel/otel";
import { registerTelemetry } from "ai";
import { LangSmithTelemetry } from "langsmith/experimental/vercel";
import { langsmithClient } from "@/lib/ai/langsmith";

export function register() {
  registerOTel({ serviceName: "chatbot" });

  // AI SDK telemetry fans out to every registered integration. Keep the
  // OpenTelemetry bridge and, when LangSmith tracing is enabled, also send
  // traces to LangSmith. Share the same client the request handlers flush
  // (see `flushLangSmith`) so background batches aren't lost in serverless.
  const integrations = [new OpenTelemetry()];
  if (langsmithClient) {
    integrations.push(LangSmithTelemetry({ client: langsmithClient }));
  }
  registerTelemetry(...integrations);
}
