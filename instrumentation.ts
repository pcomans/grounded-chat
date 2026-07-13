import { OpenTelemetry } from "@ai-sdk/otel";
import { registerOTel } from "@vercel/otel";
import { registerTelemetry } from "ai";
import { LangSmithTelemetry } from "langsmith/experimental/vercel";

export function register() {
  registerOTel({ serviceName: "chatbot" });

  // AI SDK telemetry fans out to every registered integration. Keep the
  // OpenTelemetry bridge and, when LANGSMITH_TRACING is enabled, also send
  // traces to LangSmith (config is read from LANGSMITH_* env vars).
  const integrations = [new OpenTelemetry()];
  if (process.env.LANGSMITH_TRACING === "true") {
    integrations.push(LangSmithTelemetry());
  }
  registerTelemetry(...integrations);
}
