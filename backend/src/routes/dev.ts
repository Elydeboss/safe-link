import { Router, type Request, type Response } from 'express';
import { tickAutoRelease } from '../services/escrowFlow';

const router = Router();

/** Advance auto-release timers. Wire to a cron in prod; call manually on stage. */
router.post('/tick', async (_req: Request, res: Response) => {
  try {
    const released = await tickAutoRelease();
    return res.json({ ok: true, released });
  } catch (err) {
    console.error('[tick]', err);
    return res.status(500).json({ error: 'tick failed' });
  }
});

export const devRouter = router;
