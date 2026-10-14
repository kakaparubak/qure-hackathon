/**
 * Dashboard live-update events: the seam between the backend and the nurse UI.
 *
 * Pushed over a single Server-Sent Events stream (GET /api/events). One-way by
 * design: the dashboard is read-only, so writes go through REST instead.
 */

import type { QueueLane, TriageTier } from "./session";

/**
 * The row the nurse dashboard renders.
 *
 * Shared by the REST endpoint `GET /api/queue` and the `queue_updated` SSE
 * event, so the dashboard's rendering code is identical whether data arrived by
 * fetch or by stream.
 *
 * `position` and `etaMinutes` are derived from queue entries ordered by
 * (lane, joined_at). They are never stored as mutable counters, which is how
 * the queue avoids drifting out of sync under surge.
 */
export interface QueueRow {
  /** Session this row represents. */
  sessionId: string;

  /** Patient name, or null for a skeleton record created during an emergency. */
  patientName: string | null;

  /** Triage tier, or null while still triaging. */
  tier: TriageTier;

  /** Which lane the session sits in. */
  lane: QueueLane;

  /** 1-based position within its lane. */
  position: number;

  /** Estimated minutes until seen, or null when not yet computable. */
  etaMinutes: number | null;

  /** Minutes since the session joined the queue. */
  waitedMinutes: number;

  /**
   * True when the patient has recorded allergies.
   * The dashboard must surface these: they gate what advice is safe to give.
   */
  hasAllergies: boolean;
}

/** Events pushed to the dashboard over SSE. */
export type QueueEvent =
  /** A new session entered the queue. */
  | { type: "session_created"; session: QueueRow }
  /** A session was escalated. The dashboard pins these to the top and alerts. */
  | { type: "session_escalated"; sessionId: string; tier: "P1" | "P2"; family: string }
  /** The queue ordering, positions, or ETAs changed. */
  | { type: "queue_updated"; rows: QueueRow[] }
  /** A session was served and leaves the board. */
  | { type: "session_served"; sessionId: string };
