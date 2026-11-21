import crypto from 'node:crypto';
import { config } from '../config';
import { EscrowModel, InvoiceModel, VendorModel, type IInvoice, type IEscrow } from '../models';
import { transition, canRelease, AUTO_RELEASE_HOURS, InvalidTransitionError } from '../engine/state';
import { notify } from './whatsapp';
import { initiateTransfer } from './paystack';
import { isVaultFunded, isVaultDrained, deriveEscrowPda, deriveVaultPda, solanaConfigured } from './solana';
import { recordEntry } from './ledger';
import { verifyDispatchVision } from './agent';

/**
 * Escrow orchestration — the only code that mutates invoice/escrow state,
 * always through engine/state.ts transitions. Called from webhook + API
 * routes with verified inputs.
 */

export class FlowError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
  }
}

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

function fmtUsdc(base: number): string {
  return `$${(base / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`;
}

// ─── Funding ─────────────────────────────────────────────────────────────────

export async function markFiatFunded(slug: string, externalReference: string): Promise<void> {
  const { invoice, escrow } = await loadPair(slug);
  invoice.status = transition(invoice.status, 'FIAT_FUNDED');
  invoice.externalReference = externalReference;
  escrow.autoReleaseAt = new Date(Date.now() + AUTO_RELEASE_HOURS * 3_600_000);
  await invoice.save();
  await escrow.save();

  await recordEntry({
    vendorId: invoice.vendorId,
    invoiceId: invoice._id,
    type: 'ESCROW_HOLD',
    currency: invoice.currency,
    grossAmount: invoice.amountNgn ?? 0,
    feeAmount: 0,
    netAmount: invoice.amountNgn ?? 0,
  });

  await notify(invoice.buyerPhone, `✅ Payment received for order ${slug}. Your money is now HELD IN ESCROW — the vendor cannot touch it until you confirm delivery.`);
  await notifyVendor(invoice, `🔒 Order ${slug} is FUNDED (${fmtNgn(invoice.amountNgn ?? 0)} held in escrow).\nSend the goods, then snap a photo of the package/waybill and send it HERE — I'll verify it for the buyer.`);
}

export async function markOnchainFunded(slug: string): Promise<void> {
  const { invoice, escrow } = await loadPair(slug);
  const amountUsdc = invoice.amountUsdc ?? 0;
  if (!(await isVaultFunded(escrow.escrowSeed, amountUsdc))) {
    throw new FlowError('vault balance does not cover the order amount yet', 409);
  }
  invoice.status = transition(invoice.status, 'ONCHAIN_FUNDED');
  escrow.autoReleaseAt = new Date(Date.now() + AUTO_RELEASE_HOURS * 3_600_000);
  if (solanaConfigured()) {
    escrow.onChainPdaAddress = deriveEscrowPda(escrow.escrowSeed).toBase58();
    escrow.onChainVaultAddress = deriveVaultPda(deriveEscrowPda(escrow.escrowSeed)).toBase58();
  }
  await invoice.save();
  await escrow.save();

  await recordEntry({
    vendorId: invoice.vendorId,
    invoiceId: invoice._id,
    type: 'ESCROW_HOLD',
    currency: 'USDC',
    grossAmount: amountUsdc,
    feeAmount: 0,
    netAmount: amountUsdc,
  });

  if (invoice.tradeType === 'P2P_CRYPTO') {
    await notifyVendor(
      invoice,
      `🔒 ${fmtUsdc(amountUsdc)} locked in the on-chain vault.\n\n👉 Buyer should now send ${fmtNgn(invoice.amountNgn ?? 0)} to your bank account.\nAnyone can verify the lock here:\n${config.publicBaseUrl}/pay/${slug}`,
    );
    await notify(invoice.buyerPhone, `🔒 ${fmtUsdc(amountUsdc)} is locked in escrow (order ${slug}). Send ${fmtNgn(invoice.amountNgn ?? 0)} to the seller's bank account, then tap "I have sent the Naira" on the order page. Do NOT send money before you see the lock.`);
  } else {
    await notify(invoice.buyerPhone, `✅ ${fmtUsdc(amountUsdc)} locked in escrow for order ${slug}. Vendor cannot withdraw until you confirm delivery.`);
    await notifyVendor(invoice, `🔒 Order ${slug} funded: ${fmtUsdc(amountUsdc)} held on-chain. Dispatch the goods and send the package photo here.`);
  }
}

// ─── Dispatch proof (Vision AI) ──────────────────────────────────────────────

export async function verifyDispatch(slug: string, image: { buffer: Buffer; mime: string; mediaUrl?: string }): Promise<{ verified: boolean; summary: string }> {
  const { invoice, escrow } = await loadPair(slug);
  const verdict = await verifyDispatchVision(image, invoice);

  escrow.dispatchProof = {
    mediaUrl: image.mediaUrl,
    aiVerified: verdict.aiVerified && verdict.confidence >= 0.7,
    aiSummary: verdict.aiSummary,
    confidence: verdict.confidence,
    uploadedAt: new Date(),
  };

  if (escrow.dispatchProof.aiVerified && (invoice.status === 'FUNDED_IN_ESCROW' || invoice.status === 'DISPATCHED')) {
    invoice.status = transition(invoice.status, 'DISPATCH_VERIFIED');
  }
  await invoice.save();
  await escrow.save();

  const proofLine = escrow.dispatchProof.aiVerified
    ? '✅ AI verified your dispatch proof and notified the buyer.'
    : `⚠️ I could not confidently match this photo to the order (${verdict.aiSummary}). Try a clearer photo showing the item/waybill.`;

  await notifyVendor(
    invoice,
    escrow.dispatchProof.aiVerified
      ? `📸 Dispatch proof verified for order ${slug}.\n${proofLine}\nBuyer confirms delivery here:\n${config.publicBaseUrl}/pay/${slug}`
      : `📸 Order ${slug}: ${proofLine}`,
  );
  if (escrow.dispatchProof.aiVerified) {
    await notify(invoice.buyerPhone, `📦 Order ${slug}: the vendor's dispatch photo was AI-verified ("${verdict.aiSummary}"). Track & confirm delivery here:\n${config.publicBaseUrl}/pay/${slug}`);
  }
  return { verified: escrow.dispatchProof.aiVerified, summary: verdict.aiSummary };
}

// ─── Release / refund / dispute ──────────────────────────────────────────────

export async function executeFiatRelease(slug: string, releaseToken: string, opts: { auto?: boolean } = {}): Promise<void> {
  const { invoice, escrow } = await loadPair(slug);
  if (!canRelease(invoice.status)) throw new FlowError(`cannot release from status ${invoice.status}`, 409);

  const hash = crypto.createHash('sha256').update(releaseToken).digest('hex');
  if (hash !== escrow.releaseTokenHash) throw new FlowError('invalid release token', 403);

  const vendor = await VendorModel.findById(invoice.vendorId);
  if (!vendor) throw new FlowError('vendor missing', 500);

  const gross = invoice.amountNgn ?? 0;
  const fee = feeAmount(gross);
  const net = gross - fee;

  // 1. Payout FIRST, status flip only on success (SPEC §6).
  let payoutRef: string;
  if (config.useStageMocks || !vendor.payoutDetails.paystackRecipientCode) {
    payoutRef = `mock_payout_${nanoidRef()}`;
    console.log(`[paystack:mock] transfer ${fmtNgn(net)} -> ${vendor.businessName} (${slug})`);
  } else {
    try {
      const t = await initiateTransfer({
        amountKobo: net,
        recipientCode: vendor.payoutDetails.paystackRecipientCode,
        reason: `Kolo escrow release ${slug}`,
        reference: `kolo_rel_${slug}_${nanoidRef()}`,
      });
      payoutRef = t.transfer_code;
    } catch (err) {
      console.error('[release] payout failed, status NOT changed:', (err as Error).message);
      throw new FlowError('payout failed; escrow remains held. Try again.', 502);
    }
  }

  // 2. Payout succeeded -> deterministic transition + ledger.
  invoice.status = transition(invoice.status, 'RELEASE_EXECUTED');
  await invoice.save();
  escrow.releasedAt = new Date();
  escrow.payoutTxReference = payoutRef;
  await escrow.save();

  await recordEntry({ vendorId: invoice.vendorId, invoiceId: invoice._id, type: 'CREDIT', currency: 'NGN', grossAmount: gross, feeAmount: fee, netAmount: net });
  await recordEntry({ vendorId: invoice.vendorId, invoiceId: invoice._id, type: 'FEE', currency: 'NGN', grossAmount: fee, feeAmount: fee, netAmount: fee });
  await VendorModel.updateOne({ _id: invoice.vendorId }, { $inc: { 'stats.completedEscrows': 1, 'stats.totalVolumeNgn': gross } });

  await notifyVendor(invoice, `💰 Order ${slug} RELEASED. ${fmtNgn(net)} paid out (fee ${fmtNgn(fee)}). Good sale! 🎉`);
  await notify(invoice.buyerPhone, `✅ You confirmed delivery for ${slug}. Funds released to the vendor. Thanks for using escrow!`);
  if (opts.auto) console.log(`[tick] auto-released ${slug}`);
}

export async function confirmOnchainRelease(slug: string): Promise<void> {
  const { invoice, escrow } = await loadPair(slug);
  if (!canRelease(invoice.status)) throw new FlowError(`cannot release from status ${invoice.status}`, 409);
  if (!(await isVaultDrained(escrow.escrowSeed))) {
    throw new FlowError('vault still holds funds — release transaction not confirmed yet', 409);
  }

  const gross = invoice.amountUsdc ?? 0;
  const fee = feeAmount(gross);
  const net = gross - fee;

  invoice.status = transition(invoice.status, 'RELEASE_EXECUTED');
  await invoice.save();
  escrow.releasedAt = new Date();
  await escrow.save();

  await recordEntry({ vendorId: invoice.vendorId, invoiceId: invoice._id, type: 'CREDIT', currency: 'USDC', grossAmount: gross, feeAmount: fee, netAmount: net });
  await recordEntry({ vendorId: invoice.vendorId, invoiceId: invoice._id, type: 'FEE', currency: 'USDC', grossAmount: fee, feeAmount: fee, netAmount: fee });
  await VendorModel.updateOne({ _id: invoice.vendorId }, { $inc: { 'stats.completedEscrows': 1, 'stats.totalVolumeUsdc': gross } });

  if (invoice.tradeType === 'P2P_CRYPTO') {
    await notifyVendor(invoice, `💰 Escrow ${slug} released — USDC sent to the buyer's wallet. Trade complete! 🎉`);
    await notify(invoice.buyerPhone, `✅ Seller released ${fmtUsdc(gross)} for trade ${slug}. Check your wallet.`);
  } else {
    await notifyVendor(invoice, `💰 Order ${slug} released on-chain: ${fmtUsdc(net)} to your wallet (fee ${fmtUsdc(fee)}). 🎉`);
    await notify(invoice.buyerPhone, `✅ Delivery confirmed for ${slug}. Escrow released to the vendor.`);
  }
}

export async function openDispute(slug: string, fromPhone: string, reason: string): Promise<void> {
  const { invoice, escrow } = await loadPair(slug);
  const vendor = await VendorModel.findById(invoice.vendorId);
  const isParty = fromPhone === invoice.buyerPhone || (vendor && fromPhone === vendor.whatsappNumber);
  if (!isParty) throw new FlowError('only a party to this order can open a dispute', 403);

  invoice.status = transition(invoice.status, 'DISPUTE_OPENED');
  await invoice.save();
  escrow.disputeReason = reason;
  await escrow.save();
  await VendorModel.updateOne({ _id: invoice.vendorId }, { $inc: { 'stats.disputedEscrows': 1 } });

  await notifyVendor(invoice, `⚠️ Order ${slug} is now DISPUTED. Funds frozen until it is resolved.\nReason: ${reason}`);
  await notify(invoice.buyerPhone, `⚠️ Dispute recorded for ${slug}. Funds are frozen until resolution.`);
}

export async function markFiatSent(slug: string, buyerWallet?: string): Promise<void> {
  const { invoice, escrow } = await loadPair(slug);
  if (invoice.tradeType !== 'P2P_CRYPTO') throw new FlowError('not a P2P trade', 400);
  escrow.fiatMarkedPaidAt = new Date();
  if (buyerWallet) invoice.buyerWalletAddress = buyerWallet;
  await invoice.save();
  await escrow.save();

  await notifyVendor(
    invoice,
    `🏦 Buyer marked the naira as SENT for trade ${slug}.\nCheck your bank account. If it has landed, open the order and tap "Release USDC":\n${config.publicBaseUrl}/pay/${slug}`,
  );
  await notify(invoice.buyerPhone, ` 👍 Seller notified to confirm your naira payment for ${slug}. Your USDC will be released right after.`);
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
    if (!invoice || !canRelease(invoice.status)) continue;
    if (invoice.paymentRail !== 'PAYSTACK') continue; // on-chain releases need a signature
    try {
      // auto-release has no buyer token by design; re-issue via stored hash preimage is impossible —
      // so auto-release path uses the platform payout directly:
      await releaseWithoutToken(invoice.slug, 'auto-release timer');
      released += 1;
    } catch (err) {
      console.warn(`[tick] auto-release failed for ${invoice.slug}:`, (err as Error).message);
    }
  }
  return released;
}

/** Auto-release variant: skips the buyer token (timer is the authority) but
 *  keeps every other guard. */
async function releaseWithoutToken(slug: string, reason: string): Promise<void> {
  const { invoice, escrow } = await loadPair(slug);
  if (!canRelease(invoice.status)) throw new FlowError(`cannot release from ${invoice.status}`, 409);
  const vendor = await VendorModel.findById(invoice.vendorId);
  if (!vendor) throw new FlowError('vendor missing', 500);
  const gross = invoice.amountNgn ?? 0;
  const fee = feeAmount(gross);
  const net = gross - fee;

  let payoutRef = `mock_payout_${nanoidRef()}`;
  if (!config.useStageMocks && vendor.payoutDetails.paystackRecipientCode) {
    const t = await initiateTransfer({
      amountKobo: net,
      recipientCode: vendor.payoutDetails.paystackRecipientCode,
      reason: `Kolo ${reason} ${slug}`,
      reference: `kolo_auto_${slug}_${nanoidRef()}`,
    });
    payoutRef = t.transfer_code;
  }
  invoice.status = transition(invoice.status, 'RELEASE_EXECUTED');
  await invoice.save();
  escrow.releasedAt = new Date();
  escrow.payoutTxReference = payoutRef;
  await escrow.save();
  await recordEntry({ vendorId: invoice.vendorId, invoiceId: invoice._id, type: 'CREDIT', currency: 'NGN', grossAmount: gross, feeAmount: fee, netAmount: net });
  await recordEntry({ vendorId: invoice.vendorId, invoiceId: invoice._id, type: 'FEE', currency: 'NGN', grossAmount: fee, feeAmount: fee, netAmount: fee });
  await VendorModel.updateOne({ _id: invoice.vendorId }, { $inc: { 'stats.completedEscrows': 1, 'stats.totalVolumeNgn': gross } });
  await notifyVendor(invoice, `⏰ Auto-release: order ${slug} released after the confirmation window (${reason}). ${fmtNgn(net)} paid out.`);
  await notify(invoice.buyerPhone, `⏰ Order ${slug} auto-released (no response before the deadline).`);
}

export async function notifyVendor(invoice: IInvoice, body: string): Promise<void> {
  const vendor = await VendorModel.findById(invoice.vendorId);
  if (vendor) await notify(vendor.whatsappNumber, body);
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

export { InvalidTransitionError };
