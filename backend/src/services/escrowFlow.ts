import crypto from 'node:crypto';
import { config } from '../config';
import { EscrowModel, InvoiceModel, VendorModel, type IInvoice, type IEscrow } from '../models';
import { initiateTransfer } from './paystack';
import { isVaultFunded, isVaultDrained, deriveEscrowPda, deriveVaultPda, solanaConfigured } from './solana';
import { verifyDispatchVision } from './agent';
import { getEscrowCommands, pollUntil } from '../events/commands';

/**
 * Escrow orchestration. Every mutating function here follows the same shape:
 *
 *   1. validate intent against the read models (404/403/409 fast failures)
 *   2. perform the EXTERNAL side effect — PSP payout, on-chain balance check
 *   3. append ONE immutable event through the evtstore command
 *   4. wait until the projection has folded it into the read models
 *
 * State itself is never written here: the aggregate folds events, projections
 * update Invoice/Escrow/Ledger docs and send the notifications. Invariant from
 * SPEC §6 preserved: the payout executes BEFORE the status flips, so a failed
 * payout can never swallow escrowed money.
 */

export class FlowError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

const RELEASEABLE = ['FUNDED_IN_ESCROW', 'DISPATCHED', 'DISPUTED'];

async function loadPair(slug: string): Promise<{ invoice: IInvoice; escrow: IEscrow }> {
  const invoice = await InvoiceModel.findOne({ slug });
  if (!invoice) throw new FlowError('invoice not found', 404);
  const escrow = await EscrowModel.findOne({ invoiceId: invoice._id });
  if (!escrow) throw new FlowError('escrow not found', 404);
  return { invoice, escrow };
}

function feeAmount(amount: number): number {
  // 150 bps = 1.5%, integer math
  return Math.floor((amount * config.fees.escrowFeeBps) / 10_000);
}

function fmtNgn(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

async function waitForStatus(slug: string, status: string): Promise<void> {
  await pollUntil(async () => (await InvoiceModel.findOne({ slug }))?.status === status);
}

// ─── Funding ─────────────────────────────────────────────────────────────────

export async function markFiatFunded(slug: string, externalReference: string): Promise<void> {
  const { invoice } = await loadPair(slug);
  if (invoice.status !== 'PENDING') throw new FlowError(`invalid transition: fiatFunded from ${invoice.status}`, 409);
  const cmds = await getEscrowCommands();
  await cmds.recordFiatFunded(slug, { externalReference });
  await waitForStatus(slug, 'FUNDED_IN_ESCROW');
}

export async function markOnchainFunded(slug: string): Promise<void> {
  const { invoice, escrow } = await loadPair(slug);
  if (invoice.status !== 'PENDING') throw new FlowError(`invalid transition: onchainFunded from ${invoice.status}`, 409);
  const amountUsdc = invoice.amountUsdc ?? 0;
  // Verify the money is REALLY on-chain before locking the order state.
  if (!(await isVaultFunded(escrow.escrowSeed, amountUsdc))) {
    throw new FlowError('vault balance does not cover the order amount yet', 409);
  }
  const pda = escrow.onChainPdaAddress ?? (solanaConfigured() ? deriveEscrowPda(escrow.escrowSeed).toBase58() : undefined);
  const vault = escrow.onChainVaultAddress ?? (solanaConfigured() ? deriveVaultPda(deriveEscrowPda(escrow.escrowSeed)).toBase58() : undefined);
  const cmds = await getEscrowCommands();
  await cmds.recordOnchainFunded(slug, { pdaAddress: pda, vaultAddress: vault });
  await waitForStatus(slug, 'FUNDED_IN_ESCROW');
}

// ─── Dispatch proof (Vision AI) ──────────────────────────────────────────────

export async function verifyDispatch(
  slug: string,
  image: { buffer: Buffer; mime: string; mediaUrl?: string },
): Promise<{ verified: boolean; summary: string }> {
  const { invoice } = await loadPair(slug);
  if (!['FUNDED_IN_ESCROW', 'DISPATCHED'].includes(invoice.status)) {
    throw new FlowError('order is not awaiting a dispatch proof', 409);
  }
  const verdict = await verifyDispatchVision(image, invoice);
  const verified = verdict.aiVerified && verdict.confidence >= 0.7;

  const cmds = await getEscrowCommands();
  await cmds.recordDispatchVerified(slug, {
    aiVerified: verified,
    aiSummary: verdict.aiSummary,
    confidence: verdict.confidence,
    mediaUrl: image.mediaUrl,
  });
  // Projection stores the proof (and flips to DISPATCHED when verified) + notifies both parties.
  await pollUntil(async () => {
    const esc = await EscrowModel.findOne({ invoiceId: invoice._id });
    return esc?.dispatchProof?.aiSummary === verdict.aiSummary;
  });
  return { verified, summary: verdict.aiSummary };
}

// ─── Release / refund / dispute ──────────────────────────────────────────────

export async function executeFiatRelease(slug: string, releaseToken: string, opts: { auto?: boolean } = {}): Promise<void> {
  const { invoice, escrow } = await loadPair(slug);
  if (!RELEASEABLE.includes(invoice.status)) throw new FlowError(`cannot release from status ${invoice.status}`, 409);

  // Auto-release (timer) is the authority; otherwise the buyer's capability token must match.
  if (!opts.auto) {
    const hash = crypto.createHash('sha256').update(releaseToken).digest('hex');
    if (hash !== escrow.releaseTokenHash) throw new FlowError('invalid release token', 403);
  }

  const vendor = await VendorModel.findById(invoice.vendorId);
  if (!vendor) throw new FlowError('vendor missing', 500);

  const gross = invoice.amountNgn ?? 0;
  const fee = feeAmount(gross);
  const net = gross - fee;

  // 1. Payout FIRST — the status flips only on success (SPEC §6).
  let payoutRef: string;
  if (config.useStageMocks || !vendor.payoutDetails.paystackRecipientCode) {
    payoutRef = `mock_payout_${nanoidRef()}`;
    console.log(`[paystack:mock] transfer ${fmtNgn(net)} -> ${vendor.businessName} (${slug})`);
  } else {
    try {
      const t = await initiateTransfer({
        amountKobo: net,
        recipientCode: vendor.payoutDetails.paystackRecipientCode,
        reason: `SafeLink escrow release ${slug}`,
        reference: `kolo_rel_${slug}_${nanoidRef()}`,
      });
      payoutRef = t.transfer_code;
    } catch (err) {
      console.error('[release] payout failed, status NOT changed:', (err as Error).message);
      throw new FlowError('payout failed; escrow remains held. Try again.', 502);
    }
  }

  // 2. Payout succeeded -> append fundsReleased; the projection flips status,
  //    double-books the ledger and notifies vendor + buyer.
  const cmds = await getEscrowCommands();
  await cmds.recordFundsReleased(slug, {
    gross,
    fee,
    net,
    payoutRef,
    currency: 'NGN',
    auto: Boolean(opts.auto),
    releaseToken,
  });
  await waitForStatus(slug, 'RELEASED');
  if (opts.auto) console.log(`[tick] auto-released ${slug}`);
}

export async function confirmOnchainRelease(slug: string): Promise<void> {
  const { invoice, escrow } = await loadPair(slug);
  if (!RELEASEABLE.includes(invoice.status)) throw new FlowError(`cannot release from status ${invoice.status}`, 409);
  // We never trust the client: confirm the vault really is drained.
  if (!(await isVaultDrained(escrow.escrowSeed))) {
    throw new FlowError('vault still holds funds — release transaction not confirmed yet', 409);
  }

  const gross = invoice.amountUsdc ?? 0;
  const fee = feeAmount(gross);
  const net = gross - fee;

  const cmds = await getEscrowCommands();
  await cmds.recordFundsReleased(slug, { gross, fee, net, payoutRef: `onchain_${slug}`, currency: 'USDC', auto: false });
  await waitForStatus(slug, 'RELEASED');
}

export async function openDispute(slug: string, fromPhone: string, reason: string): Promise<void> {
  const { invoice } = await loadPair(slug);
  if (!['FUNDED_IN_ESCROW', 'DISPATCHED'].includes(invoice.status)) {
    throw new FlowError(`cannot dispute from status ${invoice.status}`, 409);
  }
  const vendor = await VendorModel.findById(invoice.vendorId);
  const isParty = fromPhone === invoice.buyerPhone || (vendor && fromPhone === vendor.whatsappNumber);
  if (!isParty) throw new FlowError('only a party to this order can open a dispute', 403);

  const cmds = await getEscrowCommands();
  await cmds.openDispute(slug, { byPhone: fromPhone, reason });
  await waitForStatus(slug, 'DISPUTED');
}

export async function markFiatSent(slug: string, buyerWallet?: string): Promise<void> {
  const { invoice, escrow } = await loadPair(slug);
  if (invoice.tradeType !== 'P2P_CRYPTO') throw new FlowError('not a P2P trade', 400);
  if (!['FUNDED_IN_ESCROW', 'DISPATCHED'].includes(invoice.status)) {
    throw new FlowError(`cannot mark fiat sent from status ${invoice.status}`, 409);
  }

  const cmds = await getEscrowCommands();
  await cmds.recordFiatMarkedSent(slug, { buyerWallet });
  await pollUntil(async () => {
    const esc = await EscrowModel.findById(escrow._id);
    return Boolean(esc?.fiatMarkedPaidAt);
  });
}

/** Dev/stage helper behind USE_STAGE_MOCKS. */
export async function mockFund(slug: string): Promise<void> {
  const { invoice } = await loadPair(slug);
  if (invoice.paymentRail === 'PAYSTACK') {
    await markFiatFunded(slug, `mock_${nanoidRef()}`);
  } else {
    await markOnchainFunded(slug);
  }
}

/** Auto-release sweep — call from POST /api/dev/tick or a cron. */
export async function tickAutoRelease(): Promise<number> {
  const due = await EscrowModel.find({ autoReleaseAt: { $lte: new Date() }, releasedAt: { $exists: false } }).limit(20);
  let released = 0;
  for (const escrow of due) {
    const invoice = await InvoiceModel.findOne({ _id: escrow.invoiceId });
    if (!invoice || !RELEASEABLE.includes(invoice.status)) continue;
    if (invoice.paymentRail !== 'PAYSTACK') continue; // on-chain releases need a wallet signature
    try {
      // The timer is the authority — no buyer token on this path.
      await executeFiatRelease(invoice.slug, '', { auto: true });
      released += 1;
    } catch (err) {
      console.warn(`[tick] auto-release failed for ${invoice.slug}:`, (err as Error).message);
    }
  }
  return released;
}

/** Latest order of this vendor that is funded and awaiting a dispatch proof. */
export async function latestAwaitingDispatch(vendorPhone: string): Promise<string | null> {
  const vendorInvoices = await InvoiceModel.find({ status: 'FUNDED_IN_ESCROW' }).sort({ createdAt: -1 }).limit(10).populate('vendorId');
  for (const inv of vendorInvoices) {
    const vendor = inv.vendorId as unknown as { whatsappNumber?: string };
    if (vendor?.whatsappNumber === vendorPhone) {
      const esc = await EscrowModel.findOne({ invoiceId: inv._id });
      if (esc && !esc.dispatchProof?.aiVerified) return inv.slug;
    }
  }
  return null;
}

function nanoidRef(): string {
  return Math.random().toString(36).slice(2, 8);
}
