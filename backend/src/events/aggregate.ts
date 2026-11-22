import { createAggregate } from 'evtstore';
import type { EscrowAgg, EscrowEvt, InvoiceStatus } from './types';

/**
 * Pure fold: same transition rules as the old engine/state.ts, but now every
 * step is retained as an immutable event. Status changes ONLY through events.
 */

const FROM_FIAT_FUND = ['PENDING'];
const FROM_HELD = ['FUNDED_IN_ESCROW', 'DISPATCHED'];

export function nextStatus(status: InvoiceStatus, evtType: EscrowEvt['type']): InvoiceStatus {
  switch (evtType) {
    case 'invoiceCreated':
      return 'PENDING';
    case 'fiatFunded':
    case 'onchainFunded':
      return FROM_FIAT_FUND.includes(status) ? 'FUNDED_IN_ESCROW' : status;
    case 'dispatchVerified':
      return status === 'FUNDED_IN_ESCROW' ? 'DISPATCHED' : status;
    case 'disputeOpened':
      return FROM_HELD.includes(status) ? 'DISPUTED' : status;
    case 'fundsReleased':
      return [...FROM_HELD, 'DISPUTED'].includes(status) ? 'RELEASED' : status;
    case 'fundsRefunded':
      return [...FROM_HELD, 'DISPUTED'].includes(status) ? 'REFUNDED' : status;
    default:
      return status;
  }
}

export const escrowAgg = createAggregate<EscrowEvt, EscrowAgg, 'escrow'>({
  stream: 'escrow',
  create: (): EscrowAgg => ({
    status: 'PENDING',
    vendorPhone: '',
    tradeType: 'COMMERCE',
    currency: 'NGN',
    isEscrow: true,
    paymentRail: 'PAYSTACK',
    escrowSeed: 0,
    releaseTokenHash: '',
    aiVerified: false,
    fiatMarkedPaid: false,
    version: 0,
  }),
  fold: (evt, prev) => {
    const base: EscrowAgg = { ...prev, status: nextStatus(prev.status, evt.type) };
    switch (evt.type) {
      case 'invoiceCreated':
        return {
          ...base,
          vendorPhone: evt.vendorPhone,
          buyerPhone: evt.buyerPhone,
          tradeType: evt.tradeType,
          currency: evt.currency,
          amountNgn: evt.amountNgn,
          amountUsdc: evt.amountUsdc,
          isEscrow: evt.isEscrow,
          paymentRail: evt.paymentRail,
          escrowSeed: evt.escrowSeed,
          releaseTokenHash: evt.releaseTokenHash,
        };
      case 'dispatchVerified':
        return { ...base, aiVerified: evt.aiVerified };
      case 'fiatMarkedSent':
        return { ...base, fiatMarkedPaid: true };
      default:
        return base;
    }
  },
});
