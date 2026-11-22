import { getDomain } from './domain';
import { InvoiceModel, EscrowModel, VendorModel, LedgerEntryModel } from '../models';
import { notify } from '../services/whatsapp';
import { config } from '../config';

/**
 * Read-model projections: every immutable event updates the Mongoose docs that
 * the API and web app already read. The projections are the ONLY writers of
 * Invoice/Escrow state — commands never touch these collections directly.
 */

function fmtNgn(kobo: number): string {
  return `₦${(kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}
function fmtUsdc(base: number): string {
  return `$${(base / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`;
}

export async function startProjections(): Promise<void> {
  const { createHandler } = await getDomain();
  const model = createHandler('kolo-read-models', ['escrow']);

  // ── invoiceCreated ──────────────────────────────────────────────────────
  model.handle('escrow', 'invoiceCreated', async (slug, e) => {
    if (e.type !== 'invoiceCreated') return;
    const vendor = await VendorModel.findOneAndUpdate(
      { whatsappNumber: e.vendorPhone },
      { $setOnInsert: { businessName: `Vendor ${e.vendorPhone.slice(-4)}` } },
      { upsert: true, new: true },
    );
    const existing = await InvoiceModel.findOne({ slug });
    if (existing) return; // idempotent replay

    const invoice = await InvoiceModel.create({
      slug,
      vendorId: vendor._id,
      tradeType: e.tradeType,
      buyerPhone: e.buyerPhone,
      items: e.items,
      amountNgn: e.amountNgn,
      amountUsdc: e.amountUsdc,
      exchangeRate: e.exchangeRate,
      currency: e.currency,
      isEscrow: e.isEscrow,
      status: 'PENDING',
      paymentRail: e.paymentRail,
    });
    await EscrowModel.create({
      invoiceId: invoice._id,
      rail: e.paymentRail === 'PAYSTACK' ? 'FIAT_PSP' : 'SOLANA_PDA',
      escrowSeed: e.escrowSeed,
      onChainPdaAddress: e.onChainPdaAddress,
      onChainVaultAddress: e.onChainVaultAddress,
      releaseTokenHash: e.releaseTokenHash,
    });
  });

  // ── fiatFunded ──────────────────────────────────────────────────────────
  model.handle('escrow', 'fiatFunded', async (slug, e) => {
    if (e.type !== 'fiatFunded') return;
    const inv = await InvoiceModel.findOne({ slug });
    if (!inv) return;
    await InvoiceModel.updateOne({ slug, status: 'PENDING' }, { $set: { status: 'FUNDED_IN_ESCROW', externalReference: e.externalReference } });
    await EscrowModel.updateOne({ invoiceId: inv._id }, { $set: { autoReleaseAt: new Date(e.autoReleaseAt) } });
    await LedgerEntryModel.create({
      vendorId: inv.vendorId,
      invoiceId: inv._id,
      type: 'ESCROW_HOLD',
      currency: inv.currency,
      grossAmount: inv.amountNgn ?? 0,
      feeAmount: 0,
      netAmount: inv.amountNgn ?? 0,
    });
    await notify(inv.buyerPhone, `✅ Payment received for order ${slug}. Your money is now HELD IN ESCROW — the vendor cannot touch it until you confirm delivery.`);
    await notifyVendor(inv, `🔒 Order ${slug} is FUNDED (${fmtNgn(inv.amountNgn ?? 0)} held in escrow).\nSend the goods, then snap a photo of the package/waybill and send it HERE — I'll verify it for the buyer.`);
  });

  // ── onchainFunded ───────────────────────────────────────────────────────
  model.handle('escrow', 'onchainFunded', async (slug, e) => {
    if (e.type !== 'onchainFunded') return;
    const inv = await InvoiceModel.findOne({ slug });
    if (!inv) return;
    await InvoiceModel.updateOne({ slug, status: 'PENDING' }, { $set: { status: 'FUNDED_IN_ESCROW' } });
    await EscrowModel.updateOne(
      { invoiceId: inv._id },
      { $set: { autoReleaseAt: new Date(e.autoReleaseAt), onChainPdaAddress: e.pdaAddress, onChainVaultAddress: e.vaultAddress } },
    );
    await LedgerEntryModel.create({
      vendorId: inv.vendorId,
      invoiceId: inv._id,
      type: 'ESCROW_HOLD',
      currency: 'USDC',
      grossAmount: inv.amountUsdc ?? 0,
      feeAmount: 0,
      netAmount: inv.amountUsdc ?? 0,
    });

    if (inv.tradeType === 'P2P_CRYPTO') {
      await notifyVendor(inv, `🔒 ${fmtUsdc(inv.amountUsdc ?? 0)} locked in the on-chain vault.\n\n👉 Buyer should now send ${fmtNgn(inv.amountNgn ?? 0)} to your bank account.\nAnyone can verify the lock here:\n${config.publicBaseUrl}/pay/${slug}`);
      await notify(inv.buyerPhone, `🔒 ${fmtUsdc(inv.amountUsdc ?? 0)} is locked in escrow (order ${slug}). Send ${fmtNgn(inv.amountNgn ?? 0)} to the seller's bank account, then tap "I have sent the Naira" on the order page. Do NOT send money before you see the lock.`);
    } else {
      await notify(inv.buyerPhone, `✅ ${fmtUsdc(inv.amountUsdc ?? 0)} locked in escrow for order ${slug}. Vendor cannot withdraw until you confirm delivery.`);
      await notifyVendor(inv, `🔒 Order ${slug} funded: ${fmtUsdc(inv.amountUsdc ?? 0)} held on-chain. Dispatch the goods and send the package photo here.`);
    }
  });

  // ── dispatchVerified ────────────────────────────────────────────────────
  model.handle('escrow', 'dispatchVerified', async (slug, e) => {
    if (e.type !== 'dispatchVerified') return;
    const inv = await InvoiceModel.findOne({ slug });
    if (!inv) return;
    await EscrowModel.updateOne(
      { invoiceId: inv._id },
      {
        $set: {
          dispatchProof: {
            aiVerified: e.aiVerified,
            aiSummary: e.aiSummary,
            confidence: e.confidence,
            mediaUrl: e.mediaUrl,
            uploadedAt: new Date(),
          },
        },
      },
    );
    if (e.aiVerified) {
      await InvoiceModel.updateOne({ slug, status: 'FUNDED_IN_ESCROW' }, { $set: { status: 'DISPATCHED' } });
      await notifyVendor(inv, `📸 Dispatch proof verified for order ${slug}.\n✅ AI verified your dispatch proof and notified the buyer.\nBuyer confirms delivery here:\n${config.publicBaseUrl}/pay/${slug}`);
      await notify(inv.buyerPhone, `📦 Order ${slug}: the vendor's dispatch photo was AI-verified ("${e.aiSummary}"). Track & confirm delivery here:\n${config.publicBaseUrl}/pay/${slug}`);
    } else {
      await notifyVendor(inv, `📸 Order ${slug}: ⚠️ I could not confidently match this photo to the order (${e.aiSummary}). Try a clearer photo showing the item/waybill.`);
    }
  });

  // ── fiatMarkedSent ──────────────────────────────────────────────────────
  model.handle('escrow', 'fiatMarkedSent', async (slug, e) => {
    if (e.type !== 'fiatMarkedSent') return;
    const inv = await InvoiceModel.findOne({ slug });
    if (!inv) return;
    await EscrowModel.updateOne({ invoiceId: inv._id }, { $set: { fiatMarkedPaidAt: new Date() } });
    if (e.buyerWallet) await InvoiceModel.updateOne({ slug }, { $set: { buyerWalletAddress: e.buyerWallet } });
    await notifyVendor(inv, `🏦 Buyer marked the naira as SENT for trade ${slug}.\nCheck your bank account. If it has landed, open the order and tap "Release USDC":\n${config.publicBaseUrl}/pay/${slug}`);
    await notify(inv.buyerPhone, ` 👍 Seller notified to confirm your naira payment for ${slug}. Your USDC will be released right after.`);
  });

  // ── disputeOpened ───────────────────────────────────────────────────────
  model.handle('escrow', 'disputeOpened', async (slug, e) => {
    if (e.type !== 'disputeOpened') return;
    const inv = await InvoiceModel.findOne({ slug });
    if (!inv) return;
    await InvoiceModel.updateOne({ slug, status: { $in: ['FUNDED_IN_ESCROW', 'DISPATCHED'] } }, { $set: { status: 'DISPUTED' } });
    await EscrowModel.updateOne({ invoiceId: inv._id }, { $set: { disputeReason: e.reason } });
    await VendorModel.updateOne({ _id: inv.vendorId }, { $inc: { 'stats.disputedEscrows': 1 } });
    await notifyVendor(inv, `⚠️ Order ${slug} is now DISPUTED. Funds frozen until it is resolved.\nReason: ${e.reason}`);
    await notify(inv.buyerPhone, `⚠️ Dispute recorded for ${slug}. Funds are frozen until resolution.`);
  });

  // ── fundsReleased ───────────────────────────────────────────────────────
  model.handle('escrow', 'fundsReleased', async (slug, e) => {
    if (e.type !== 'fundsReleased') return;
    const inv = await InvoiceModel.findOne({ slug });
    if (!inv) return;
    await InvoiceModel.updateOne(
      { slug, status: { $in: ['FUNDED_IN_ESCROW', 'DISPATCHED', 'DISPUTED'] } },
      { $set: { status: 'RELEASED' } },
    );
    await EscrowModel.updateOne({ invoiceId: inv._id }, { $set: { releasedAt: new Date(), payoutTxReference: e.payoutRef } });
    await LedgerEntryModel.create({
      vendorId: inv.vendorId,
      invoiceId: inv._id,
      type: 'CREDIT',
      currency: e.currency,
      grossAmount: e.gross,
      feeAmount: e.fee,
      netAmount: e.net,
    });
    await LedgerEntryModel.create({
      vendorId: inv.vendorId,
      invoiceId: inv._id,
      type: 'FEE',
      currency: e.currency,
      grossAmount: e.fee,
      feeAmount: e.fee,
      netAmount: e.fee,
    });
    const inc: Record<string, number> = { 'stats.completedEscrows': 1 };
    if (e.currency === 'NGN') inc['stats.totalVolumeNgn'] = e.gross;
    else inc['stats.totalVolumeUsdc'] = e.gross;
    await VendorModel.updateOne({ _id: inv.vendorId }, { $inc: inc });

    const fmt = e.currency === 'NGN' ? fmtNgn : fmtUsdc;
    if (e.auto) {
      await notifyVendor(inv, `⏰ Auto-release: order ${slug} released after the confirmation window. ${fmt(e.net)} paid out.`);
      await notify(inv.buyerPhone, `⏰ Order ${slug} auto-released (no response before the deadline).`);
    } else if (inv.tradeType === 'P2P_CRYPTO') {
      await notifyVendor(inv, `💰 Escrow ${slug} released — USDC sent to the buyer's wallet. Trade complete! 🎉`);
      await notify(inv.buyerPhone, `✅ Seller released ${fmt(e.gross)} for trade ${slug}. Check your wallet.`);
    } else {
      await notifyVendor(inv, `💰 Order ${slug} RELEASED. ${fmt(e.net)} paid out (fee ${fmt(e.fee)}). Good sale! 🎉`);
      await notify(inv.buyerPhone, `✅ You confirmed delivery for ${slug}. Funds released to the vendor. Thanks for using escrow!`);
    }
  });

  // ── fundsRefunded ───────────────────────────────────────────────────────
  model.handle('escrow', 'fundsRefunded', async (slug, _e) => {
    const inv = await InvoiceModel.findOne({ slug });
    if (!inv) return;
    await InvoiceModel.updateOne(
      { slug, status: { $in: ['FUNDED_IN_ESCROW', 'DISPATCHED', 'DISPUTED'] } },
      { $set: { status: 'REFUNDED' } },
    );
    await LedgerEntryModel.create({
      vendorId: inv.vendorId,
      invoiceId: inv._id,
      type: 'REFUND',
      currency: inv.currency,
      grossAmount: inv.amountNgn ?? inv.amountUsdc ?? 0,
      feeAmount: 0,
      netAmount: inv.amountNgn ?? inv.amountUsdc ?? 0,
    });
  });

  await model.start();
  console.log('[events] projections started');
}

async function notifyVendor(invoice: { vendorId: unknown }, body: string): Promise<void> {
  const vendor = await VendorModel.findById(invoice.vendorId as never);
  if (vendor) await notify(vendor.whatsappNumber, body);
}
