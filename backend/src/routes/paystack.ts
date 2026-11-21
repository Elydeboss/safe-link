import { Router, type Request, type Response } from 'express';
import { verifyWebhookSignature } from '../services/paystack';
import { markFiatFunded } from '../services/escrowFlow';

const router = Router();

/**
 * Paystack webhook. CRITICAL: verified against HMAC-SHA512 of the RAW body
 * (captured in index.ts before JSON parsing). Only then may state change.
 */
router.post('/', (req: Request, res: Response) => {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  const signature = req.headers['x-paystack-signature'] as string | undefined;

  if (!raw || !verifyWebhookSignature(raw, signature)) {
    return res.status(401).send('invalid signature');
  }
  res.sendStatus(200); // ack fast, work async

  const { event, data } = req.body as { event: string; data?: { reference?: string } };
  const reference = data?.reference;

  void (async () => {
    try {
      if (event === 'charge.success' && reference) {
        console.log(`[paystack] charge.success ref=${reference}`);
        await markFiatFunded(reference, reference); // reference == invoice slug (set at checkout)
      } else {
        console.log(`[paystack] event ${event} ignored`);
      }
    } catch (err) {
      // non-fatal: e.g. duplicate webhook -> invalid transition
      console.warn('[paystack] handler:', (err as Error).message);
    }
  })();
});

export const paystackWebhookRouter = router;
