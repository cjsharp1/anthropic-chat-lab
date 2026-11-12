/**
 * try-flaky.ts — proves the unreliable tool is reliably unreliable.
 *
 * Run it with:  npm run try-flaky
 *
 * The point of this script is the thing that makes flaky_service useful
 * for teaching: its failure is controllable. Ten calls at failRate 1 fail
 * ten times. Ten at failRate 0 succeed ten times. A tool that failed at
 * random would make for a demonstration that works or does not depending
 * on the day.
 */

import {
  flakyService,
  resetFlakyCounters,
} from "../server/tools/definitions/flaky-service.js";

/** Calls the tool `times` times and reports how many failed. */
async function runBatch(
  label: string,
  input: Record<string, unknown>,
  times: number,
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;

  for (let i = 0; i < times; i += 1) {
    try {
      await flakyService.run(input as never);
      ok += 1;
    } catch {
      failed += 1;
    }
  }

  console.log(`  ${label.padEnd(30)} ${ok} succeeded, ${failed} failed`);
  return { ok, failed };
}

console.log("=== DONE CHECK: ten at failRate 1, then ten at 0 ===");
resetFlakyCounters();

const always = await runBatch("failRate 1 (×10)", { itemId: "widget-42", failRate: 1 }, 10);
const never = await runBatch("failRate 0 (×10)", { itemId: "widget-42", failRate: 0 }, 10);

const passed = always.failed === 10 && always.ok === 0 && never.ok === 10 && never.failed === 0;
console.log(`  -> ${passed ? "PASS" : "FAIL"}: failure is fully controllable\n`);

console.log("=== in between, it really is random ===");
resetFlakyCounters();
await runBatch("failRate 0.5 (×20)", { itemId: "widget-42", failRate: 0.5 }, 20);
await runBatch("failRate 0.2 (×20)", { itemId: "widget-42", failRate: 0.2 }, 20);

console.log("\n=== each failure mode produces a message Claude can act on ===");
for (const mode of ["timeout", "unavailable", "rate_limited", "bad_response", "not_found"]) {
  try {
    await flakyService.run({ itemId: "widget-42", failRate: 1, failureMode: mode } as never);
    console.log(`  ${mode.padEnd(14)} did not fail — unexpected`);
  } catch (error: unknown) {
    console.log(`  ${mode.padEnd(14)} ${(error as Error).message.split(" (call")[0]}`);
  }
}

console.log("\n=== a successful call returns something ===");
console.log(" ", await flakyService.run({ itemId: "widget-42", failRate: 0 } as never));

console.log("\n=== the delay makes parallel execution visible (step 42) ===");
const started = Date.now();
await Promise.all([
  flakyService.run({ itemId: "a", failRate: 0 } as never),
  flakyService.run({ itemId: "b", failRate: 0 } as never),
  flakyService.run({ itemId: "c", failRate: 0 } as never),
]);
const parallel = Date.now() - started;

const serialStart = Date.now();
await flakyService.run({ itemId: "a", failRate: 0 } as never);
await flakyService.run({ itemId: "b", failRate: 0 } as never);
await flakyService.run({ itemId: "c", failRate: 0 } as never);
const serial = Date.now() - serialStart;

console.log(`  three calls in parallel: ${parallel}ms`);
console.log(`  three calls in sequence: ${serial}ms`);
