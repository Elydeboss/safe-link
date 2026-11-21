import { Router, type Request, type Response } from 'express';
import { config } from '../config';
import { downloadMedia, sendText } from '../services/whatsapp';
import { handleText, transcribeVoice } from '../services/agent';
import { verifyDispatch } from '../services/escrowFlow';
import { InvoiceModel, EscrowModel } from '../models';

const router = Router();

// GET: Meta webhook verification handshake.
router.get('/', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Message-id dedupe (Meta retries webhooks; we must not double-process).
const seen = new Set<string>();

// POST: inbound messages. Ack immediately, process async.
router.post('/', (req: Request, res: Response) => {
  res.sendStatus(200);
  void processPayload(req.body).catch((err) => console.error('[whatsapp] processing error:', err));
});

async function processPayload(payload: unknown): Promise<void> {
  const value = firstValue(payload);
  if (!value?.messages?.length) return; // status updates, etc.

  for (const msg of value.messages) {
    if (seen.has(msg.id)) continue;
    seen.add(msg.id);
    if (seen.size > 500) seen.clear(); // crude but fine for a hackathon

    const phone: string = msg.from;
    const profileName: string = value.contacts?.[0]?.profile?.name ?? '';
    console.log(`[whatsapp] <- ${phone} (${profileName}) [${msg.type}]`);

    try {
      switch (msg.type) {
        case 'text': {
          const text = msg.text?.body?.trim();
          if (!text) break;
          const reply = await handleText(phone, profileName, text);
          await sendText(phone, reply);
          break;
        }
        case 'audio': {
          if (!msg.audio?.id) break;
          const media = await downloadMedia(msg.audio.id);
          const transcript = await transcribeVoice(media.buffer, media.mime);
          console.log(`[whatsapp] voice transcript: ${transcript}`);
          const reply = await handleText(phone, profileName, transcript);
          await sendText(phone, reply);
          break;
        }
        case 'image': {
          if (!msg.image?.id) break;
          const media = await downloadMedia(msg.image.id);
          // Route to the vendor's most recent FUNDED order awaiting dispatch proof.
          const target = await latestAwaitingDispatch(phone);
          if (!target) {
            await sendText(phone, 'I see a photo 📸 — but no funded order is waiting for a dispatch proof. Create an invoice first (e.g. "Invoice 2 sneakers 45k for Tunde").');
            break;
          }
          const result = await verifyDispatch(target, { buffer: media.buffer, mime: media.mime, mediaUrl: media.url });
          await sendText(phone, result.verified ? '✅ Proof verified and buyer notified.' : `⚠️ ${result.summary}`);
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.error('[whatsapp] message failed:', (err as Error).message);
      await sendText(phone, 'Oops, something broke on my side. Please try again.').catch(() => {});
    }
  }
}

async function latestAwaitingDispatch(vendorPhone: string): Promise<string | null> {
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

interface WhatsAppValue {
  contacts?: Array<{ profile?: { name?: string } }>;
  messages?: Array<{
    id: string;
    from: string;
    type: string;
    text?: { body?: string };
    audio?: { id?: string };
    image?: { id?: string };
  }>;
}

interface WhatsAppPayload {
  entry?: Array<{ changes?: Array<{ value?: WhatsAppValue }> }>;
}

function firstValue(payload: unknown): WhatsAppValue | undefined {
  const p = payload as WhatsAppPayload;
  return p.entry?.[0]?.changes?.[0]?.value;
}

export const whatsappWebhookRouter = router;
