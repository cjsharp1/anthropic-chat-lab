/**
 * types.ts — re-exports the shared contract for server code.
 *
 * The definitions themselves live in shared/types.ts, because the
 * browser needs the same ones and used to carry a hand-copied
 * duplicate of them. That duplicate drifted: adding a stream event
 * meant editing two files, and forgetting the second was a compile
 * error rather than anything worse, but it happened twice in one
 * afternoon.
 *
 * This file stays so that every `from "./types.js"` and
 * `from "../../types.js"` in server/ keeps working. It adds nothing
 * of its own.
 */

export type {
  LogLevel,
  LogDirection,
  LogEvent,
  StreamEvent,
} from "../shared/types.js";
