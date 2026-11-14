/**
 * try-effort.ts — what does each effort level actually buy?
 *
 * Run it with:  npm run try-effort
 *               npm run try-effort -- --model claude-sonnet-5-5
 *               npm run try-effort -- --runs 3
 *
 * Like the other scripts here, this is a command-line process with no
 * browser, so it reads the provider key selected by AI_PROVIDER from .env — it cannot see a key
 * set in the app's Settings dialog. See the Setup section of README.md.
 *
 * Clicking through the app proves the setting is wired up. It does not
 * answer the question you actually have, which is when a higher level
 * is worth paying for — and a single run cannot answer that, because
 * two calls at the SAME level differ by a few hundred tokens anyway.
 *
 * So this runs two questions of deliberately different difficulty
 * across every level, optionally several times each, and prints them
 * side by side. The useful result is the comparison between the two
 * questions, not either one alone:
 *
 *   - On the hard question, higher levels spend much more and the
 *     answer changes.
 *   - On the easy one, higher levels spend more and return the same
 *     thing. That is the case worth seeing, because it is the one
 *     where effort is costing you money for nothing.
 *
 * It also watches for the trap: at the top levels a model can spend
 * its whole budget thinking and return NO answer at all, with
 * stop_reason "max_tokens". That is not a bug in the app — it is what
 * happens when the ceiling is too low for the level.
 */

import { apiModelId, getClient } from "../server/anthropic.js";
import { summariseUsage, formatCost } from "../server/usage.js";

/** The levels, cheapest first. */
const LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type Level = (typeof LEVELS)[number];

/**
 * Two questions, chosen to disagree with each other.
 *
 * The easy one is a definition — there is a correct answer, it is
 * short, and no amount of thinking improves it. The hard one has two
 * intertwined causes and asks for a judgement about their
 * relationship, which is the shape of question that reasoning helps.
 *
 * If both questions behaved the same way, the control would not be
 * worth having.
 */
const QUESTIONS = [
  {
    name: "easy",
    note: "a definition — one right answer, nothing to work out",
    text: "What does the stop_reason value \"end_turn\" mean?",
  },
  {
    name: "hard",
    note: "two causes, intertwined, needs a judgement about both",
    text:
      "I run a tool loop. Claude returns two tool_use blocks in one " +
      "turn, I execute both and send the results back, and " +
      "intermittently get a 400. Separately my cache hit rate fell to " +
      "zero when I added a sixth tool. Explain both, say whether they " +
      "share a cause, and give the order I should fix them in.",
  },
];

/** One measurement. */
interface Result {
  level: Level;
  outputTokens: number;
  thinkingChars: number;
  answerChars: number;
  cost: number;
  elapsedMs: number;
  stopReason: string | null;
  /** True when the model used its whole budget and never answered. */
  truncated: boolean;
}

/** Reads a flag like --model X, falling back to a default. */
function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

/** Asks one question at one level. */
async function measure(
  question: string,
  level: Level,
  model: string,
  maxTokens: number,
): Promise<Result> {
  const started = Date.now();

  const response = await getClient().messages.create({
    model: apiModelId(model),
    max_tokens: maxTokens,
    // Summarized, so the thinking is measurable rather than an empty
    // block. The tokens are spent either way — see server/thinking.ts.
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: level },
    messages: [{ role: "user", content: question }],
  });

  const thinking = response.content
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking)
    .join("");

  const answer = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  const usage = summariseUsage(response.usage, response.model);

  return {
    level,
    outputTokens: usage.output,
    thinkingChars: thinking.length,
    answerChars: answer.length,
    cost: usage.cost,
    elapsedMs: Date.now() - started,
    stopReason: response.stop_reason,
    truncated: response.stop_reason === "max_tokens" && answer.length === 0,
  };
}

/** Averages several runs, so one noisy call does not read as a trend. */
function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

async function main(): Promise<void> {
  const model = flag("model", "claude-haiku-5-5");
  const maxTokens = Number(flag("max-tokens", "16000"));
  const runs = Number(flag("runs", "1"));

  console.log(`\nmodel      ${model}`);
  console.log(`max_tokens ${maxTokens}`);
  console.log(`runs       ${runs} per level`);
  console.log(
    "\nSpending real money: " +
      `${QUESTIONS.length * LEVELS.length * runs} requests.\n`,
  );

  for (const question of QUESTIONS) {
    console.log(`\n${question.name.toUpperCase()} — ${question.note}`);
    console.log(`  "${question.text.slice(0, 64)}…"\n`);

    console.log(
      "  level    out tok   think   answer        cost     time   stop",
    );
    console.log("  " + "-".repeat(66));

    let baseline: Result | null = null;

    for (const level of LEVELS) {
      const samples: Result[] = [];
      for (let run = 0; run < runs; run += 1) {
        samples.push(await measure(question.text, level, model, maxTokens));
      }

      const result: Result = {
        level,
        outputTokens: Math.round(mean(samples.map((s) => s.outputTokens))),
        thinkingChars: Math.round(mean(samples.map((s) => s.thinkingChars))),
        answerChars: Math.round(mean(samples.map((s) => s.answerChars))),
        cost: mean(samples.map((s) => s.cost)),
        elapsedMs: Math.round(mean(samples.map((s) => s.elapsedMs))),
        stopReason: samples[0]?.stopReason ?? null,
        truncated: samples.some((s) => s.truncated),
      };

      baseline ??= result;

      // Multiples of the cheapest level, which is the number that
      // answers "what is this costing me".
      const costRatio = result.cost / baseline.cost;
      const answerRatio =
        baseline.answerChars === 0
          ? 0
          : result.answerChars / baseline.answerChars;

      console.log(
        `  ${result.level.padEnd(8)}` +
          `${String(result.outputTokens).padStart(7)}` +
          `${String(result.thinkingChars).padStart(8)}` +
          `${String(result.answerChars).padStart(9)}` +
          `${formatCost(result.cost).padStart(12)}` +
          `${String(result.elapsedMs + "ms").padStart(9)}` +
          `   ${result.stopReason ?? "?"}` +
          (result.truncated ? "  ⚠ NO ANSWER" : "") +
          (result.level === baseline.level
            ? ""
            : `   (${costRatio.toFixed(1)}× cost, ` +
              `${answerRatio.toFixed(2)}× answer length)`),
      );
    }
  }

  console.log(
    "\nWhat to look for:\n" +
      "  - Cost climbs steeply with the level, but answer LENGTH\n" +
      "    barely moves on either question. The extra tokens go into\n" +
      "    thinking, not into more words — so length does not tell\n" +
      "    you whether a level helped. Read the two answers instead.\n" +
      "  - On the easy question that is the whole story: 5× the cost\n" +
      "    to define one field, for the same answer. Effort you are\n" +
      "    paying for and not receiving.\n" +
      "  - ⚠ NO ANSWER means the model spent its whole max_tokens\n" +
      "    budget thinking. Raise max_tokens or lower the level.\n" +
      "  - Levels are not a monotonic ladder: high can spend fewer\n" +
      "    tokens than medium on the same question. Run with\n" +
      "    --runs 3 before believing any single comparison.\n",
  );
}

await main();
