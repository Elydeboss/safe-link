/**
 * Escrow lifecycle — event-sourced with evtstore.
 * This is the SOURCE OF TRUTH for order state; the Mongoose Invoice/Escrow
 * collections are projections (read models) maintained by projections.ts.
 *
 * Event names mirror engine/state.ts's EscrowEvent vocabulary — the fold below
 * produces the same status transitions the pure state machine validated before.
 */

export type EscrowEvt =
  | {
      type: 'invoiceCreated';
      vendorPhone: string;
      buyerPhone?: string;
      tradeType: 'COMMERCE' | 'P2P_CRYPTO';
      items: Array<{ name: string; quantity: number; unitPrice: number }>;
      amountNgn?: number; // kobo
      amountUsdc?: number; // base units
      exchangeRate?: number;
      currency: 'NGN' | 'USDC';
      isEscrow: boolean;
      paymentRail: 'PAYSTACK' | 'SOLANA_PDA';
      escrowSeed: number;
      releaseTokenHash: string;
      onChainPdaAddress?: string;
      onChainVaultAddress?: string;
    }
  | { type: 'fiatFunded'; externalReference: string; autoReleaseAt: string }
  | { type: 'onchainFunded'; autoReleaseAt: string; pdaAddress?: string; vaultAddress?: string }
  | {
      type: 'dispatchVerified';
      aiVerified: boolean;
      aiSummary: string;
      confidence: number;
      mediaUrl?: string;
    }
  | { type: 'fiatMarkedSent'; buyerWallet?: string }
  | { type: 'disputeOpened'; byPhone: string; reason: string }
  | { type: 'fundsReleased'; gross: number; fee: number; net: number; payoutRef: string; currency: 'NGN' | 'USDC'; auto: boolean }
  | { type: 'fundsRefunded' };

export type InvoiceStatus =
  | 'PENDING'
  | 'FUNDED_IN_ESCROW'
  | 'DISPATCHED'
  | 'RELEASED'
  | 'DISPUTED'
  | 'REFUNDED'
  | 'CANCELLED';

export interface EscrowAgg {
  status: InvoiceStatus;
  vendorPhone: string;
  buyerPhone?: string;
  tradeType: 'COMMERCE' | 'P2P_CRYPTO';
  currency: 'NGN' | 'USDC';
  amountNgn?: number;
  amountUsdc?: number;
  isEscrow: boolean;
  paymentRail: 'PAYSTACK' | 'SOLANA_PDA';
  escrowSeed: number;
  releaseTokenHash: string;
  aiVerified: boolean;
  fiatMarkedPaid: boolean;
  version: number;
}

export type EscrowCmd =
  | { type: 'createInvoice'; payload: Omit<Extract<EscrowEvt, { type: 'invoiceCreated' }>, 'type'> }
  | { type: 'recordFiatFunded'; externalReference: string; releaseToken?: string }
  | { type: 'recordOnchainFunded'; pdaAddress?: string; vaultAddress?: string }
  | { type: 'recordDispatchVerified'; aiVerified: boolean; aiSummary: string; confidence: number; mediaUrl?: string }
  | { type: 'recordFiatMarkedSent'; buyerWallet?: string }
  | { type: 'openDispute'; byPhone: string; reason: string }
  | { type: 'recordFundsReleased'; gross: number; fee: number; net: number; payoutRef: string; currency: 'NGN' | 'USDC'; auto: boolean; releaseToken?: string }
  | { type: 'recordFundsRefunded' };
