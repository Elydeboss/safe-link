import { Router, type Request, type Response } from 'express';
import { InvoiceModel, EscrowModel, VendorModel } from '../models';

const router = Router();

/** Public data for the checkout / release web page. No secrets leak:
 *  releaseTokenHash and payout details are stripped. */
router.get('/:slug', async (req: Request, res: Response) => {
  const invoice = await InvoiceModel.findOne({ slug: req.params.slug }).populate('vendorId');
  if (!invoice) return res.status(404).json({ error: 'invoice not found' });

  const escrow = await EscrowModel.findOne({ invoiceId: invoice._id });
  const vendor = invoice.vendorId as unknown as {
    businessName?: string;
    payoutDetails?: { solanaWalletAddress?: string };
  };

  return res.json({
    invoice: {
      slug: invoice.slug,
      tradeType: invoice.tradeType,
      items: invoice.items,
      amountNgn: invoice.amountNgn,
      amountUsdc: invoice.amountUsdc,
      exchangeRate: invoice.exchangeRate,
      currency: invoice.currency,
      isEscrow: invoice.isEscrow,
      status: invoice.status,
      paymentRail: invoice.paymentRail,
      buyerWalletAddress: invoice.buyerWalletAddress,
    },
    escrow: escrow
      ? {
          rail: escrow.rail,
          escrowSeed: escrow.escrowSeed,
          onChainPdaAddress: escrow.onChainPdaAddress,
          onChainVaultAddress: escrow.onChainVaultAddress,
          dispatchProof: escrow.dispatchProof
            ? { aiVerified: escrow.dispatchProof.aiVerified, aiSummary: escrow.dispatchProof.aiSummary, uploadedAt: escrow.dispatchProof.uploadedAt }
            : null,
          autoReleaseAt: escrow.autoReleaseAt,
          fiatMarkedPaidAt: escrow.fiatMarkedPaidAt,
          disputeReason: escrow.disputeReason,
          releasedAt: escrow.releasedAt,
        }
      : null,
    vendor: {
      businessName: vendor?.businessName ?? 'Vendor',
      solanaWalletAddress: vendor?.payoutDetails?.solanaWalletAddress ?? null,
    },
    solana: {
      rpcUrl: config.solana.rpcUrl,
      programId: config.solana.programId || null,
      usdcMint: config.solana.usdcMint || null,
      platformFeeWallet: config.solana.platformFeeWallet || null,
    },
  });
});

export const invoicesRouter = router;
