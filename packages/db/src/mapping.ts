import type { Decision, InboundMessage, OutboundMessage } from '@qure/core';
import { redFlagFamily, messages, triageResults } from './schema';

type VerdictContext = Pick<typeof triageResults.$inferInsert, 'flowAction' | 'messageId' | 'tier' | 'escalated' | 'cutoffUsed' | 'usedFallback' | 'modelLatencyMs'>;
export function decisionToRow(sessionId: string, decision: Decision, context: VerdictContext): typeof triageResults.$inferInsert {
  const family = decision.matchedFamily;
  if (family !== null && !redFlagFamily.enumValues.some(value => value === family)) {
    throw new Error(`Unknown red-flag family: ${family}`);
  }
  return {
    ...context, sessionId, layer:decision.source,
    redFlagFamily: family as typeof redFlagFamily.enumValues[number] | null,
    modelName:decision.model, scoreUrgency:decision.urgency,
    urgencyConfidence:decision.urgencyConfidence, clarity:decision.clarity,
    scoreRedFlag:decision.redFlag, scoreRedFlagInformal:decision.redFlagInformal,
    scoreWantsHuman:decision.wantsHuman, category:decision.category,
    redFlagFired:decision.source === 'red_flag_floor', rawOutput:decision.raw,
  };
}
export function inboundToRow(sessionId:string, msg:InboundMessage): typeof messages.$inferInsert {
  return {sessionId,direction:'inbound',sender:'patient',kind:msg.kind,body:msg.text,
    waMessageId:msg.providerMessageId,createdAt:msg.receivedAt,meta:{phone:msg.phone}};
}
export function outboundToRow(sessionId:string, msg:OutboundMessage, providerMessageId?:string): typeof messages.$inferInsert {
  return {sessionId,direction:'outbound',sender:'bot',kind:'text',body:msg.text,
    waMessageId:providerMessageId,meta:{phone:msg.phone,purpose:msg.purpose}};
}
