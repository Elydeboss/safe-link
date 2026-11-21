import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { handleText } from '../services/agent';
import { verifyDispatch, latestAwaitingDispatch } from '../services/escrowFlow';

/**
 * Web chat ingress — the SAME Tier 1 agent pipeline as the WhatsApp webhook
 * (handleText -> tools -> deterministic engine). This is our Meta-independent
 * surface: identical behavior, no Cloud API dependency. Also lets the demo be
 * screen-recorded cleanly on desktop.
 *
 * NOTE (honest limitation): no auth — demo endpoint. WhatsApp ingress carries
 * Meta's identity; production would add vendor sessions here.
 */
const router = Router();

const chatSchema = z.object({
  phone: z.string().min(7),
  name: z.string().optional(),
  text: z.string().optional(),
  imageBase64: z.string().optional(),
  imageMime: z.string().optional(),
});

router.post('/', async (req: Request, res: Response) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'phone required, plus text or imageBase64' });
  const { phone, name, text, imageBase64, imageMime } = parsed.data;

  try {
    // Image -> dispatch proof verification (same routing as the WhatsApp image path)
    if (imageBase64) {
      const buffer = Buffer.from(imageBase64, 'base64');
      const target = await latestAwaitingDispatch(phone);
      if (!target) {
        return res.json({ reply: 'I see a photo 📸 — but no funded order is waiting for a dispatch proof. Create an invoice first (e.g. "Invoice 2 sneakers 45k for Tunde").' });
      }
      const result = await verifyDispatch(target, { buffer, mime: imageMime ?? 'image/jpeg' });
      return res.json({ reply: result.verified ? `✅ Dispatch proof verified for order ${target} and buyer notified.` : `⚠️ ${result.summary}` });
    }

    if (!text?.trim()) return res.status(400).json({ error: 'empty message' });
    const reply = await handleText(phone, name?.trim() || 'Vendor', text.trim());
    return res.json({ reply });
  } catch (err) {
    console.error('[chat]', err);
    return res.status(500).json({ error: 'agent failed — check AI keys (AI_API_KEY)' });
  }
});

export const chatRouter = router;
