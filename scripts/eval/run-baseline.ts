import "./load-env";
import { evaluate } from "langsmith/evaluation";
import { runAgent } from "../../lib/eval/agent-target";
import { correctness } from "../../lib/eval/correctness";

// Which LangSmith dataset to run against (default: the needles).
const datasetName = process.argv[2] ?? "egypt-nubia-needles-v0.1";

async function main() {
  const experiment = await evaluate(
    (inputs: { question: string }) => runAgent(inputs.question),
    {
      data: datasetName,
      evaluators: [correctness],
      experimentPrefix: `baseline-${datasetName}`,
      maxConcurrency: 4,
    }
  );

  const rows = experiment.results ?? [];
  const total = rows.length;
  const correct = rows.reduce((sum, row) => {
    const result = row.evaluationResults.results.find(
      (r) => r.key === "correctness"
    );
    return sum + (Number(result?.score) || 0);
  }, 0);

  const pct = total ? ((correct / total) * 100).toFixed(1) : "0.0";
  console.log(
    `\n${datasetName}: correctness ${correct}/${total} (${pct}%)\nView the run in LangSmith → project "${process.env.LANGSMITH_PROJECT ?? "default"}".`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
