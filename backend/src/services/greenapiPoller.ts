import { config } from '../config';
import { sendText } from './whatsapp';
import { handleText, transcribeVoice } from './agent';
import { verifyDispatch, latestAwaitingDispatch } from './escrowFlow';
import { greenCall, greenDownload, greenState } from './greenapi';

/**
 * Green API ingress — polls ReceiveNotification every GREEN_API_POLL_MS and feeds
 * the SAME agent pipeline the Meta webhook uses (GREENAPI.md §6.3). Semantics:
 *
 *   - one in-flight poll at a time; the poller can never crash the process
 *   - every received notification is ALWAYS deleted (ack) — even on dispatch
 *     failure, so a poison message cannot wedge the queue
 *   - groups (@g.us) ignored; idMessage dedupe guards redelivery edges
 *   - consecutive errors push a growing quiet period (3s → 30s)
 */

interface GreenNotification {
  typeWebhook: string;
  idMessage: string;
  timestamp: number;
  senderData?: {
    chatId?: string;
    sender?: string;
    chatName?: string;
    senderName?: string;
    senderContactName?: string;
  };
  messageData?: {
    typeMessage: string;
    textMessage?: string;
    extendedTextMessage?: { text?: string };
    imageMessage?: { downloadMessageId?: string; caption?: string; mimeType?: string };
    audioMessage?: { downloadMessageId?: string; mimeType?: string };
    [k: string]: unknown;
  };
}

interface Receipt {
  receiptId: number;
  body: GreenNotification;
}

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let resumeAt = 0;
const seen = new Set<string>();
const SEEN_MAX = 500;

export function startGreenApiPoller(): void {
  if (timer) return;
  console.log(`[greenapi] poller started (${config.greenApi.pollMs}ms interval)`);
  void checkStateOnce();
  timer = setInterval(() => void tick(), config.greenApi.pollMs);
}

export function stopGreenApiPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function checkStateOnce(): Promise<void> {
  try {
    const state = await greenState();
    if (state === 'authorized') console.log('[greenapi] instance authorized ✅');
    else
      console.warn(
        `[greenapi] instance state: ${state} — scan the QR to go live (console.green-api.com → instance → QR, ` +
          `or GET ${config.greenApi.baseUrl}/waInstance${config.greenApi.instanceId}/qr/${config.greenApi.apiToken})`,
      );
  } catch (err) {
    console.warn('[greenapi] state check failed:', (err as Error).message);
  }
}

async function tick(): Promise<void> {
  if (inFlight || Date.now() < resumeAt) return;
  inFlight = true;
  try {
    const note = await greenCall<Receipt>('receiveNotification');
    if (note?.body) {
      try {
        await dispatch(note.body);
      } finally {
        // ALWAYS ack — see header. Delete failure = retry next tick (idempotent via `seen`).
        await greenCall(`deleteNotification/${note.receiptId}`, { method: 'DELETE' }).catch((err) =>
          console.warn(`[greenapi] delete ${note.receiptId} failed:`, (err as Error).message),
        );
      }
    }
    resumeAt = 0; // success resets any quiet period
  } catch (err) {
    const quiet = resumeAt && resumeAt > Date.now() ? Math.min((resumeAt - Date.now()) * 2, 30_000) : 3_000;
    resumeAt = Date.now() + quiet;
    console.warn(`[greenapi] poll error (retry in ${Math.round(quiet / 1000)}s):`, (err as Error).message);
  } finally {
    inFlight = false;
  }
}

async function dispatch(b: GreenNotification): Promise<void> {
  if (seen.has(b.idMessage)) return;
  seen.add(b.idMessage);
  if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);

  if (b.typeWebhook !== 'incomingMessageReceived') return; // statuses/state changes: ignore

  const chatId = b.senderData?.chatId ?? '';
  if (!chatId.endsWith('@c.us')) return; // groups / unknown: ignore
  const phone = chatId.replace(/@c\.us$/, '');
  const name = b.senderData?.senderContactName || b.senderData?.senderName || 'Vendor';
  const md = b.messageData;

  try {
    switch (md?.typeMessage) {
      case 'textMessage': {
        const text = md.textMessage?.trim();
        if (!text) return;
        const reply = await handleText(phone, name, text);
        await sendText(phone, reply);
        return;
      }
      case 'extendedTextMessage': {
        const text = md.extendedTextMessage?.text?.trim();
        if (!text) return;
        const reply = await handleText(phone, name, text);
        await sendText(phone, reply);
        return;
      }
      case 'imageMessage': {
        const downloadId = md.imageMessage?.downloadMessageId;
        if (!downloadId) return;
        const target = await latestAwaitingDispatch(phone);
        if (!target) {
          await sendText(phone, 'I see a photo 📸 — but no funded order is waiting for a dispatch proof. Create an invoice first (e.g. "Invoice 2 sneakers 45k for Tunde").');
          return;
        }
        const media = await greenDownload(downloadId);
        const result = await verifyDispatch(target, { buffer: media.buffer, mime: media.mime, mediaUrl: media.url });
        await sendText(phone, result.verified ? `✅ Dispatch proof verified for order ${target} — the buyer has been notified.` : `⚠️ ${result.summary}`);
        return;
      }
      case 'audioMessage': {
        const downloadId = md.audioMessage?.downloadMessageId;
        if (!downloadId) return;
        const media = await greenDownload(downloadId);
        const transcript = await transcribeVoice(media.buffer, media.mime);
        console.log(`[greenapi] voice note from ${phone}: "${transcript.slice(0, 120)}"`);
        if (!transcript.trim()) {
          await sendText(phone, 'I could not hear anything in that voice note 🤔 — try again?');
          return;
        }
        const reply = await handleText(phone, name, transcript);
        await sendText(phone, reply);
        return;
      }
      default:
        await sendText(phone, "I can't read that yet — send text, a voice note, or a photo 🙏");
    }
  } catch (err) {
    console.error(`[greenapi] dispatch failed (${phone} / ${md?.typeMessage}):`, err);
    await sendText(phone, '⚠️ Something went wrong handling that — please try again.').catch(() => {});
  }
}
