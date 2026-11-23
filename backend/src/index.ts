import express, { type Request } from 'express';
import { config, warnMissingConfig, whatsappProvider } from './config';
import { connectDb } from './db';
import { whatsappWebhookRouter } from './routes/whatsapp';
import { paystackWebhookRouter } from './routes/paystack';
import { chatRouter } from './routes/chat';
import { invoicesRouter } from './routes/invoices';
import { escrowsRouter } from './routes/escrows';
import { devRouter } from './routes/dev';
import { startProjections } from './events/projections';
import { startGreenApiPoller } from './services/greenapiPoller';
import { greenState } from './services/greenapi';

async function main(): Promise<void> {
  warnMissingConfig();

  try {
    await connectDb();
    console.log('[db] connected');
  } catch (err) {
    console.error('[db] connect failed — starting anyway, will retry per request:', (err as Error).message);
  }

  // Event-sourced core: fold the escrow event stream into the read models.
  // Must run before any command is accepted, otherwise nothing materializes.
  try {
    await startProjections();
  } catch (err) {
    console.error('[events] projections failed to start:', (err as Error).message);
  }

  const app = express();

  // Capture the raw body BEFORE parsing so the Paystack HMAC check sees exact bytes.
  app.use(
    express.json({
      limit: '2mb',
      verify: (req: Request, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  // Green API state is a live external call — cache 60s so /api/health stays fast.
  let waStateCache: { at: number; state: string } | null = null;
  async function whatsappHealth(): Promise<{ provider: string; state?: string }> {
    const provider = whatsappProvider();
    if (provider !== 'greenapi') return { provider };
    if (!waStateCache || Date.now() - waStateCache.at > 60_000) {
      try {
        waStateCache = { at: Date.now(), state: await greenState() };
      } catch {
        waStateCache = { at: Date.now(), state: 'unknown' };
      }
    }
    return { provider, state: waStateCache.state };
  }

  app.get('/api/health', async (_req, res) =>
    res.json({ ok: true, mocks: config.useStageMocks, whatsapp: await whatsappHealth(), ts: Date.now() }),
  );

  app.use('/webhooks/whatsapp', whatsappWebhookRouter);
  app.use('/webhooks/paystack', paystackWebhookRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/escrows', escrowsRouter);
  app.use('/api/dev', devRouter);
  app.use('/api/chat', chatRouter);

  // WhatsApp ingress: Green API poller (demo transport). Meta uses the webhook route instead.
  if (whatsappProvider() === 'greenapi') startGreenApiPoller();

  app.listen(config.port, () => {
    console.log(`[safelink] backend listening on :${config.port}`);
    console.log(`[safelink] public base url: ${config.publicBaseUrl}`);
  });
}

void main();
