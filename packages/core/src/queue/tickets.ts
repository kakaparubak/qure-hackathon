/**
 * Queue tickets: the patient-facing and board-facing queue surface.
 *
 * A ticket number is a stable per-day label ("you are number 12 today"). It is
 * NOT the live position - position shifts as emergencies jump the queue, the
 * ticket never does. The two are shown as separate values everywhere.
 */

import type { QueueRow } from "../contracts";

/** One board row: contract QueueRow plus the stable per-day ticket identity. */
export interface QueueTicketRow extends QueueRow {
  /** Per-day ticket number, 1-based, stable after issuance. */
  ticketNumber: number;
  /** Local day the ticket was issued for (YYYY-MM-DD); numbering resets daily. */
  ticketDate: string;
}

/**
 * Reply telling a routine patient their intake is complete and queued.
 *
 * Only routine patients get a ticket in chat. An escalation reply stays exactly
 * the fixed playbook - safety text is never appended to or edited.
 */
export function ticketReplyText(ticket: { ticketNumber: number; position: number }): string {
  return [
    "Terima kasih, informasi awal pasien sudah lengkap dan tersimpan.",
    `Nomor antrean Anda: ${ticket.ticketNumber} (posisi saat ini: ${ticket.position}).`,
    "Tunjukkan pesan ini di loket. Jika keluhan memburuk, balas pesan ini.",
  ].join("\n");
}
