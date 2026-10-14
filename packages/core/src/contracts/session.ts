/**
 * Session state machine: the seam between the triage pipeline and the queue.
 *
 * A session is one visit episode - one conversation with one patient, from the
 * first message until the nurse has served them.
 */

/** Where a session currently sits in its lifecycle. */
export type SessionStatus =
  /** Conversation open, pipeline running. */
  | "triaging"
  /** In the queue, check-in loop active. */
  | "waiting"
  /** Flagged for a human; the while-you-wait playbook has been sent. */
  | "escalated"
  /** Surge active: self-care guidance plus a callback slot offered instead of the live queue. */
  | "green_lane"
  /** Nurse completed the interaction. */
  | "served"
  /** Terminal. */
  | "closed";

/** Which queue a session belongs to. Ordering is derived, never stored. */
export type QueueLane =
  /** Escalated cases. */
  | "priority"
  /** Ordinary queue. */
  | "normal"
  /** Surge diversion lane: self-care plus callback. */
  | "green";

/** Triage tier. null while a session is still being triaged. */
export type TriageTier = "P1" | "P2" | "P3" | null;

/**
 * Legal session status transitions.
 *
 * This map does real safety work, and the properties worth defending are:
 * `closed` is terminal (no outgoing edges), and no status can transition back
 * into `waiting` (a session is never resurrected into the queue). That keeps
 * queue state from drifting out of sync with the database.
 *
 * `waiting -> escalated` is retained deliberately: a patient who deteriorates
 * while queueing must be able to escalate mid-wait. That is the feature that
 * addresses the "waited five hours unreassessed" failure mode.
 *
 * Changing this map is an architecture change, not a refactor.
 */
export const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  triaging: ["waiting", "escalated", "closed"],
  waiting: ["escalated", "served", "green_lane", "closed"],
  escalated: ["served", "closed"],
  green_lane: ["escalated", "closed"],
  served: ["closed"],
  closed: [],
};
