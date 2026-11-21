import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import {
  executeFiatRelease,
  confirmOnchainRelease,
  markOnchainFunded,
  markFiatSent,
  openDispute,
  mockFund,
  FlowError,
} from '../services/escrowFlow';
import { isChargeSuccessful } from '../services/paystack';

const router = Router();

/** Buyer confirms delivery -> release FIAT escrow (capability token). */
const releaseSchema = z.object({ releaseToken: z.string().min(10) });
router.post('/:slug/release', async (req: Request, res: Response) => {
  const parsed = releaseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'releaseToken required' });
  try {
    await executeFiatRelease(req.params.slug, parsed.data.releaseToken);
    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof FlowError) return res.status(err.status).json({ error: err.message });
    console.error('[release]', err);
    return res.status(500).json({ error: 'release failed' });
  }
});

/** Web page reports a USDC deposit happened -> we verify the vault balance ourselves. */
router.post('/:slug/onchain-deposit', async (req: Request, res: Response) => {
  try {
    await markOnchainFunded(req.params.slug);
    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof FlowError) return res.status(err.status).json({ error: err.message });
    console.error('[onchain-deposit]', err);
    return res.status(500).json({ error: 'deposit verification failed' });
  }
});

/** Web page reports an on-chain release happened -> we verify the vault is drained. */
router.post('/:slug/onchain-release', async (req: Request, res: Response) => {
  try {
    await confirmOnchainRelease(req.params.slug);
    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof FlowError) return res.status(err.status).json({ error: err.message });
    console.error('[onchain-release]', err);
    return res.status(500).json({ error: 'release verification failed' });
  }
});

/** P2P: buyer says "I have sent the naira". */
const fiatSentSchema = z.object({ buyerWallet: z.string().optional() });
router.post('/:slug/fiat-sent', async (req: Request, res: Response) => {
  const parsed = fiatSentSchema.safeParse(req.body ?? {});
  try {
    await markFiatSent(req.params.slug, parsed.success ? parsed.data.buyerWallet : undefined);
    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof FlowError) return res.status(err.status).json({ error: err.message });
    console.error('[fiat-sent]', err);
    return res.status(500).json({ error: 'failed' });
  }
});

/** Either party freezes the escrow. */
const disputeSchema = z.object({ fromPhone: z.string().min(7), reason: z.string().max(300).optional() });
router.post('/:slug/dispute', async (req: Request, res: Response) => {
  const parsed = disputeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'fromPhone required' });
  try {
    await openDispute(req.params.slug, parsed.data.fromPhone, parsed.data.reason ?? 'No reason given');
    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof FlowError) return res.status(err.status).json({ error: err.message });
    console.error('[dispute]', err);
    return res.status(500).json({ error: 'failed' });
  }
});

/** Server-side fallback when the webhook tunnel hiccups: we still verify with
 *  Paystack ourselves before trusting the client. */
router.post('/:slug/confirm-fiat', async (req: Request, res: Response) => {
  try {
    const ok = await isChargeSuccessful(req.params.slug);
    if (!ok) return res.status(409).json({ error: 'payment not confirmed on Paystack yet' });
    await executeQuietFiatFund(req.params.slug);
    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof FlowError) return res.status(err.status).json({ error: err.message });
    console.error('[confirm-fiat]', err);
    return res.status(500).json({ error: 'failed' });
  }
});

/** Stage/demo helper: pretend the payment webhook fired. */
router.post('/:slug/mock-fund', async (req: Request, res: Response) => {
  if (!config.useStageMocks) return res.status(403).json({ error: 'USE_STAGE_MOCKS=false' });
  try {
    await mockFund(req.params.slug);
    return res.json({ ok: true });
  } catch (err) {
    if (err instanceof FlowError) return res.status(err.status).json({ error: err.message });
    console.error('[mock-fund]', err);
    return res.status(500).json({ error: 'failed' });
  }
});

async function executeQuietFiatFund(slug: string): Promise<void> {
  const { markFiatFunded } = await import('../services/escrowFlow');
  try {
    await markFiatFunded(slug, `${slug}/confirm`);
  } catch (err) {
    // already funded via webhook -> fine
    if (!(err instanceof Error && err.message.includes('invalid transition'))) throw err;
  }
}

export const escrowsRouter = router;
