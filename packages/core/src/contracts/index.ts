/**
 * Frozen interface contracts for Qure!.
 *
 * These are the seams where separately-built parts of the system hand data to
 * each other. They are deliberately pure type declarations: no functions, no
 * classes, no implementation. The single runtime export is
 * `ALLOWED_TRANSITIONS`, which carries its own test.
 *
 * Freezing these first is what allows the channel adapter, the triage
 * pipeline, and the dashboard to be built in parallel.
 */

export * from "./decision";
export * from "./message";
export * from "./session";
export * from "./events";
