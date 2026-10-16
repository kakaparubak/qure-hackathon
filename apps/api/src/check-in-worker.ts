import type { WhatsAppChannel } from '@qure/core';
import type { CheckInEngine } from '@qure/db';
import { CHECK_IN_POLL_MS } from '@qure/core/check-in/policy';
import { startQueueWorker } from './queue-worker';

/** Webhook-only mode must not reserve attempts or pretend to deliver reminders. */
export function startCheckInWorker(engine:CheckInEngine,channel:WhatsAppChannel|null,logger:(message:string)=>void,intervalMs=CHECK_IN_POLL_MS) {
  if(!channel) return {async close(){}};
  return startQueueWorker(engine,channel,logger,intervalMs,'Check-in');
}
