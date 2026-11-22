import express, { type Request } from 'express';
import { config, warnMissingConfig } from './config';
import { connectDb } from './db';
import { whatsappWebhookRouter } from './routes/whatsapp';
import { paystackWebhookRouter } from './routes/paystack';
import { chatRouter } from './routes/chat';
import { invoicesRouter } from './routes/invoices';
import { escrowsRouter } from './routes/escrows';
import { devRouter } from './routes/dev';
import { startProjections } from './events/projections';

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

  app.get('/api/health', (_req, res) => res.json({ ok: true, mocks: config.useStageMocks, ts: Date.now() }));

  app.use('/webhooks/whatsapp', whatsappWebhookRouter);
  app.use('/webhooks/paystack', paystackWebhookRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/escrows', escrowsRouter);
  app.use('/api/dev', devRouter);
  app.use('/api/chat', chatRouter);

  app.listen(config.port, () => {
    console.log(`[safelink] backend listening on :${config.port}`);
    console.log(`[safelink] public base url: ${config.publicBaseUrl}`);
  });
}

void main();
