import "./load-env";
import { readFileSync } from "node:fs";
import { Client } from "langsmith";

type Row = {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

const DATA_DIR = "/Users/philipp/Books/Egypt and Nubia GC/evals";

const DATASETS = [
  {
    description:
      "Egypt & Nubia RAG needles v0.1 — single-chunk factoids a no-context model gets wrong. Measures retrieval lift.",
    file: "egypt_nubia_needles_v0.1.jsonl",
    name: "egypt-nubia-needles-v0.1",
  },
  {
    description:
      "Egypt & Nubia common-knowledge controls v0.1 — a no-context model already answers these. Baseline (non-lift) sanity set.",
    file: "rejected_common_knowledge_v0.1.jsonl",
    name: "egypt-nubia-controls-v0.1",
  },
];

async function upload(client: Client, ds: (typeof DATASETS)[number]) {
  if (await client.hasDataset({ datasetName: ds.name })) {
    console.log(
      `⏭  ${ds.name} already exists — skipping (delete it in LangSmith to re-upload).`
    );
    return;
  }

  const rows = readFileSync(`${DATA_DIR}/${ds.file}`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);

  const dataset = await client.createDataset(ds.name, {
    description: ds.description,
  });

  await client.createExamples({
    datasetId: dataset.id,
    inputs: rows.map((r) => r.inputs),
    metadata: rows.map((r) => r.metadata ?? {}),
    outputs: rows.map((r) => r.outputs),
  });

  console.log(`✅ Uploaded ${rows.length} examples → ${ds.name}`);
}

async function main() {
  const client = new Client();
  await Promise.all(DATASETS.map((ds) => upload(client, ds)));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
