import { config } from '../config';

/**
 * Minimal Meta WhatsApp Cloud API client.
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 * The TEST phone number can free-form reply to any number that messaged it
 * first within the 24h customer service window — which is exactly our flow.
 */

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

export async function sendText(to: string, body: string): Promise<void> {
  if (config.useStageMocks || !config.whatsapp.token) {
    console.log(`[whatsapp:mock] -> ${to}: ${body.slice(0, 160)}`);
    return;
  }
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

/** Downloads media (voice note / image) with the app token — media URLs are
 *  NOT publicly fetchable despite the https URL they return. */
export async function downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mime: string; url: string }> {
  const { url } = await graph<{ url: string }>(mediaId);
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
