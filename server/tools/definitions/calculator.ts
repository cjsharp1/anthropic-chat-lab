/**
 * calculator.ts — arithmetic Claude can call.
 *
 * The traditional first tool, and worth asking why it exists at all: a
 * model can obviously add two numbers. The point is not the arithmetic.
 * It is that arithmetic is *verifiable*. When you ask "what is 7 times 6"
 * and watch a tool_use block appear in the log panel with those exact
 * arguments, you can see the mechanism working. A tool that fetched the
 * weather would teach the same loop while leaving you unsure whether the
 * answer came from the tool or from the model's own guess.
 *
 * ---------------------------------------------------------------------------
 * The security point, which is the real lesson here
 * ---------------------------------------------------------------------------
 *
 * The obvious way to write a calculator tool is to take an expression as a
 * string and evaluate it:
 *
 *     run: async ({ expression }) => String(eval(expression))   // NEVER
 *
 * Do not do this. `eval` runs arbitrary JavaScript with the full privileges
 * of the server process. The string comes from the model, and the model's
 * output is influenced by whatever the user typed — so a user who writes
 * the right thing can get code of their choosing executed on your machine.
 * That is remote code execution, reachable through a chat box.
 *
 * It does not help to "sanitise" the expression first. People have been
 * losing that arms race for decades.
 *
 * The fix is structural rather than defensive: do not accept a program.
 * Accept two numbers and the name of an operation, and switch on it. There
 * is then no string to evaluate and nothing to escape — the dangerous
 * capability was never created in the first place.
 *
 * This generalises. Whenever a tool's input is "some code" or "a command"
 * or "a query", ask whether it can instead be a small set of named options
 * with typed arguments. Usually it can.
 */

import { z } from "zod";
import { defineTool } from "../types.js";

/**
 * The operations on offer.
 *
 * A Zod enum rather than a free string. This becomes an `enum` in the JSON
 * Schema the API sees, so the model is told exactly which values are
 * allowed — fewer invalid calls, and anything unexpected is rejected by
 * validation before `run` is reached.
 */
const operationSchema = z.enum([
  "add",
  "subtract",
  "multiply",
  "divide",
  "power",
  "modulo",
]);

const inputSchema = z.object({
  a: z.number().describe("The first number"),
  b: z.number().describe("The second number"),
  op: operationSchema.describe("Which arithmetic operation to perform"),
});

/** The symbol for each operation, used when reporting the result. */
const SYMBOLS: Record<z.infer<typeof operationSchema>, string> = {
  add: "+",
  subtract: "−",
  multiply: "×",
  divide: "÷",
  power: "^",
  modulo: "mod",
};

export const calculator = defineTool({
  name: "calculator",

  // Written for the model. It says what the tool is for, and — more
  // usefully — rules out the case it would otherwise be reached for.
  description:
    "Performs exact arithmetic on two numbers. Use this for any calculation " +
    "where precision matters, rather than working it out yourself. " +
    "Takes two numbers and one operation: add, subtract, multiply, divide, " +
    "power, or modulo. It does not evaluate expressions — to compute " +
    "something like (3 + 4) × 5, call it once per step.",

  // A prompt that reliably triggers this tool, with a note on
  // what to watch for. Shown in the Tools tab: a tool nobody
  // knows how to invoke teaches nothing.
  examplePrompt: "What is 847293 multiplied by 61847?",
  exampleWatch:
    "Six digits by five is beyond what Claude will do in its head, so it reaches for the tool. Ask it 7 times 6 instead and watch it answer directly — models do not call tools they do not need.",

  inputSchema,

  run: async ({ a, b, op }) => {
    let result: number;

    // A switch, not an evaluator. Every branch is code we wrote; nothing
    // from the model is ever executed.
    switch (op) {
      case "add":
        result = a + b;
        break;

      case "subtract":
        result = a - b;
        break;

      case "multiply":
        result = a * b;
        break;

      case "divide":
        // JavaScript returns Infinity for x/0 rather than throwing, which
        // would give Claude a nonsense number with no indication anything
        // went wrong. Throwing instead produces a tool_result flagged as an
        // error by tool-runner.ts, which the model can actually
        // respond to.
        if (b === 0) {
          throw new Error("Cannot divide by zero.");
        }
        result = a / b;
        break;

      case "power":
        result = a ** b;
        break;

      case "modulo":
        if (b === 0) {
          throw new Error("Cannot take a modulo of zero.");
        }
        result = a % b;
        break;
    }

    // Catches the overflow cases JavaScript reports silently: 1e308 ** 2 is
    // Infinity, and some operations produce NaN. Returning either to the
    // model as if it were an answer would be worse than failing.
    if (!Number.isFinite(result)) {
      throw new Error(
        `The result is not a finite number (${result}). The inputs may be too large.`,
      );
    }

    // Return the whole calculation, not just the number. "42" tells Claude
    // nothing about what produced it; if several tools ran in parallel, the
    // restated sum is what lets the model match result to request.
    return `${a} ${SYMBOLS[op]} ${b} = ${result}`;
  },
});
