import crypto from 'node:crypto';
import { createCommands } from 'evtstore';
import { getDomain } from './domain';
import type { EscrowAgg, EscrowCmd, EscrowEvt } from './types';

/**
 * Escrow lifecycle commands — the ONLY writers of order state.
 * Each handler validates intent against the folded aggregate BEFORE any event
 * is appended (same guards the old engine/state.ts enforced), then returns the
 * immutable event. External side effects (payouts, WhatsApp pings) live in
 * escrowFlow + projections, never here.
 */

const HELD = ['FUNDED_IN_ESCROW', 'DISPATCHED'];
const RELEASEABLE = ['FUNDED_IN_ESCROW', 'DISPATCHED', 'DISPUTED'];
const AUTO_RELEASE_AT = () => new Date(Date.now() + 24 * 3_600_000).toISOString();

async function buildCommands() {
  const { domain } = await getDomain();
  return createCommands<EscrowEvt, EscrowAgg, EscrowCmd>(
    domain.escrow,
    {
      async createInvoice(cmd, agg) {
        if (agg.vendorPhone) throw new Error('invoice already exists for this id');
        return { type: 'invoiceCreated', ...cmd.payload };
      },

      async recordFiatFunded(cmd, agg) {
        if (agg.status !== 'PENDING') throw new Error(`invalid transition: fiatFunded from ${agg.status}`);
        return { type: 'fiatFunded', externalReference: cmd.externalReference, autoReleaseAt: AUTO_RELEASE_AT() };
      },

      async recordOnchainFunded(cmd, agg) {
        if (agg.status !== 'PENDING') throw new Error(`invalid transition: onchainFunded from ${agg.status}`);
        return {
          type: 'onchainFunded',
          autoReleaseAt: AUTO_RELEASE_AT(),
          pdaAddress: cmd.pdaAddress,
          vaultAddress: cmd.vaultAddress,
        };
      },

      async recordDispatchVerified(cmd, agg) {
        if (!HELD.includes(agg.status)) throw new Error(`invalid transition: dispatchVerified from ${agg.status}`);
        return {
          type: 'dispatchVerified',
          aiVerified: cmd.aiVerified,
          aiSummary: cmd.aiSummary,
          confidence: cmd.confidence,
          mediaUrl: cmd.mediaUrl,
        };
      },

      async recordFiatMarkedSent(cmd, agg) {
        if (agg.tradeType !== 'P2P_CRYPTO') throw new Error('not a P2P trade');
        if (!HELD.includes(agg.status)) throw new Error(`invalid transition: fiatMarkedSent from ${agg.status}`);
        return { type: 'fiatMarkedSent', buyerWallet: cmd.buyerWallet };
      },

      async openDispute(cmd, agg) {
        if (!HELD.includes(agg.status)) throw new Error(`invalid transition: disputeOpened from ${agg.status}`);
        return { type: 'disputeOpened', byPhone: cmd.byPhone, reason: cmd.reason };
      },

      async recordFundsReleased(cmd, agg) {
        if (!RELEASEABLE.includes(agg.status)) throw new Error(`invalid transition: fundsReleased from ${agg.status}`);
        // Fiat rails: the buyer's capability token (or the auto-release timer) is the authority.
        if (agg.paymentRail === 'PAYSTACK' && !cmd.auto) {
          const hash = crypto.createHash('sha256').update(cmd.releaseToken ?? '').digest('hex');
          if (hash !== agg.releaseTokenHash) throw new Error('invalid release token');
        }
        return {
          type: 'fundsReleased',
          gross: cmd.gross,
          fee: cmd.fee,
          net: cmd.net,
          payoutRef: cmd.payoutRef,
          currency: cmd.currency,
          auto: cmd.auto,
        };
      },

      async recordFundsRefunded(_cmd, agg) {
        if (!RELEASEABLE.includes(agg.status)) throw new Error(`invalid transition: fundsRefunded from ${agg.status}`);
        return { type: 'fundsRefunded' };
      },
    },
  );
}

let commandsCache: Awaited<ReturnType<typeof buildCommands>> | null = null;

export async function getEscrowCommands() {
  if (!commandsCache) commandsCache = await buildCommands();
  return commandsCache;
}

/**
 * Events are appended asynchronously; read models (Invoice/Escrow/Ledger docs)
 * catch up when the projection polls. Mutation flows poll until the expected
 * state is visible, so callers and tests observe a consistent result.
 */
export async function pollUntil(cond: () => Promise<boolean>, timeoutMs = 8000, intervalMs = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('projection did not catch up in time');
}
