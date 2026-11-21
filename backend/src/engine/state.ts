import type { InvoiceStatus } from '../models/invoice';

/**
 * Deterministic state machine. Tier 2 ONLY — no LLM output ever reaches this
 * module. Every event must originate from a verified webhook signature,
 * a confirmed on-chain state, or a valid capability token.
 */
export type EscrowEvent =
  | 'FIAT_FUNDED' // Paystack charge.success (HMAC-verified webhook or verify call)
  | 'ONCHAIN_FUNDED' // Solana vault balance confirmed >= amount via RPC
  | 'DISPATCH_VERIFIED' // Vision AI verified dispatch proof (>= confidence threshold)
  | 'RELEASE_EXECUTED' // payout succeeded (fiat transfer confirmed / vault drained)
  | 'REFUND_EXECUTED' // refund executed (on-chain cancel confirmed)
  | 'DISPUTE_OPENED' // either party opened a dispute
  | 'RESOLVE_RELEASE' // admin resolved dispute in favor of vendor
  | 'RESOLVE_REFUND' // admin resolved dispute in favor of buyer
  | 'AUTO_RELEASE_DUE'; // autoReleaseAt passed with no dispute

const TRANSITIONS: Record<EscrowEvent, { from: InvoiceStatus[]; to: InvoiceStatus }> = {
  FIAT_FUNDED: { from: ['PENDING'], to: 'FUNDED_IN_ESCROW' },
  ONCHAIN_FUNDED: { from: ['PENDING'], to: 'FUNDED_IN_ESCROW' },
  DISPATCH_VERIFIED: { from: ['FUNDED_IN_ESCROW'], to: 'DISPATCHED' },
  // NOTE: only emitted AFTER the payout actually succeeded (fixes the PRD bug
  // where status flipped to RELEASED before the transfer).
  RELEASE_EXECUTED: { from: ['FUNDED_IN_ESCROW', 'DISPATCHED', 'DISPUTED'], to: 'RELEASED' },
  REFUND_EXECUTED: { from: ['FUNDED_IN_ESCROW', 'DISPATCHED', 'DISPUTED'], to: 'REFUNDED' },
  DISPUTE_OPENED: { from: ['FUNDED_IN_ESCROW', 'DISPATCHED'], to: 'DISPUTED' },
  RESOLVE_RELEASE: { from: ['DISPUTED'], to: 'RELEASED' },
  RESOLVE_REFUND: { from: ['DISPUTED'], to: 'REFUNDED' },
  // AUTO_RELEASE_DUE is an intent, not a direct transition: the tick runs the
  // normal release pipeline and emits RELEASE_EXECUTED once payout succeeds.
  AUTO_RELEASE_DUE: { from: ['FUNDED_IN_ESCROW', 'DISPATCHED'], to: 'FUNDED_IN_ESCROW' },
};

export class InvalidTransitionError extends Error {
  constructor(status: InvoiceStatus, event: EscrowEvent) {
    super(`invalid transition: event ${event} not allowed from status ${status}`);
  }
}

export function transition(status: InvoiceStatus, event: EscrowEvent): InvoiceStatus {
  const rule = TRANSITIONS[event];
  if (!rule) throw new InvalidTransitionError(status, event);
  if (!rule.from.includes(status)) throw new InvalidTransitionError(status, event);
  if (event === 'AUTO_RELEASE_DUE') return status; // handled by release pipeline
  return rule.to;
}

export function canRelease(status: InvoiceStatus): boolean {
  return status === 'FUNDED_IN_ESCROW' || status === 'DISPATCHED';
}

export const AUTO_RELEASE_HOURS = 24;
