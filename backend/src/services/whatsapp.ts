import { config, whatsappProvider } from '../config';
import { greenSendText, greenDownload } from './greenapi';

/**
 * WhatsApp transport facade. Callers see one API — sendText/downloadMedia/notify —
 * regardless of the provider behind it (resolved in config.whatsappProvider):
 *
 *   greenapi — Green API gateway, linked-device protocol (demo transport; see GREENAPI.md)
 *   meta     — WhatsApp Cloud API (production path; webhook at /webhooks/whatsapp)
 *   mock     — console logs (tests, stage safety net)
 */

export { whatsappProvider };

// ─── Meta Cloud API implementation ───────────────────────────────────────────

const BASE = `https://graph.facebook.com/${config.whatsapp.graphVersion}`;

async function graph<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.whatsapp.token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`whatsapp api ${path} failed: ${res.status} ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

// ─── Facade ──────────────────────────────────────────────────────────────────

export async function sendText(to: string, body: string): Promise<void> {
  const provider = whatsappProvider();
  if (provider === 'mock') {
    console.log(`[whatsapp:mock] -> ${to}: ${body.slice(0, 160)}`);
    return;
  }
  if (provider === 'greenapi') {
    await greenSendText(to, body);
    return;
  }
  // meta — provider resolution guarantees a token here
  await graph(`${config.whatsapp.phoneNumberId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: true, body },
    }),
  });
}

/** Downloads inbound media. `ref` = Meta media id, or Green API downloadMessageId. */
export async function downloadMedia(ref: string): Promise<{ buffer: Buffer; mime: string; url: string }> {
  if (whatsappProvider() === 'greenapi') return greenDownload(ref);
  // Meta path: media URLs are NOT publicly fetchable despite the https URL.
  const { url } = await graph<{ url: string }>(ref);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${config.whatsapp.token}` } });
  if (!res.ok) throw new Error(`media download failed: ${res.status}`);
  const mime = res.headers.get('content-type') ?? 'application/octet-stream';
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mime, url };
}

/** Fire-and-forget helper so notification failures never break a flow. */
export async function notify(to: string | undefined, body: string): Promise<void> {
  if (!to) return;
  try {
    await sendText(to, body);
  } catch (err) {
    console.warn('[whatsapp] notify failed (non-fatal):', (err as Error).message);
  }
}
