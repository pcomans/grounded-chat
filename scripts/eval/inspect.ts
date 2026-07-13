import "./load-env";
import { readFileSync } from "node:fs";
import { runAgent } from "../../lib/eval/agent-target";
import { correctness } from "../../lib/eval/correctness";

// Per-example inspector: runs the agent + judge on a local jsonl and prints
// question / gold / agent answer / verdict, so we can tell judge false-negatives
// apart from genuine model misses. Usage: tsx scripts/eval/inspect.ts <file.jsonl>

const DATA_DIR = "/Users/philipp/Books/Egypt and Nubia GC/evals";
const file = process.argv[2] ?? "rejected_common_knowledge_v0.1.jsonl";

type Row = {
  inputs: { question: string };
  outputs: { reference_answer: string };
};

async function main() {
  const rows = readFileSync(`${DATA_DIR}/${file}`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Row);

  const graded = await Promise.all(
    rows.map(async (row) => {
      const { answer } = await runAgent(row.inputs.question);
      const verdict = await correctness(
        { outputs: { answer } } as never,
        {
          inputs: row.inputs,
          outputs: row.outputs,
        } as never
      );
      return { answer, reference: row.outputs.reference_answer, row, verdict };
    })
  );

  const pass = graded.filter((g) => g.verdict.score).length;
  for (const [i, g] of graded.entries()) {
    const mark = g.verdict.score ? "✅" : "❌";
    process.stdout.write(
      `\n${mark} [${i + 1}] ${g.row.inputs.question}\n` +
        `   GOLD:   ${g.reference}\n` +
        `   AGENT:  ${g.answer.replace(/\s+/g, " ").slice(0, 400)}\n` +
        `   JUDGE:  ${g.verdict.comment.replace(/\s+/g, " ").slice(0, 200)}\n`
    );
  }
  process.stdout.write(`\n\n=== ${pass}/${graded.length} correct ===\n`);
}

main().catch((error) => {
  process.stderr.write(`${error}\n`);
  process.exit(1);
});
