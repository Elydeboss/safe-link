import { config } from '../config';

/**
 * Green API gateway client (WhatsApp linked-device protocol).
 * Docs: https://green-api.com/docs/api/ — pattern:
 *   {baseUrl}/waInstance{id}/{method}/{token}[?query]
 *
 * This is the DEMO transport (WHATSAPP_PROVIDER=greenapi): no Meta verification,
 * free Developer tier, 3-chat budget, ReceiveNotification polling for ingress.
 * The Meta Cloud API path stays implemented for production (whatsapp.ts facade).
 */

function endpoint(method: string, query?: string): string {
  const { baseUrl, instanceId, apiToken } = config.greenApi;
  return `${baseUrl}/waInstance${instanceId}/${method}/${apiToken}${query ? `?${query}` : ''}`;
}

/** Low-level call shared by the client and the poller. Empty body → undefined (204). */
export async function greenCall<T>(method: string, init?: RequestInit & { query?: string }): Promise<T | undefined> {
  const res = await fetch(endpoint(method, init?.query), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`greenapi ${method} failed: ${res.status} ${body.slice(0, 300)}`);
  }
  const text = await res.text();
  if (!text) return undefined;
  return JSON.parse(text) as T;
}

export async function greenSendText(to: string, body: string): Promise<string> {
  const r = await greenCall<{ idMessage: string }>('sendMessage', {
    method: 'POST',
    body: JSON.stringify({ chatId: `${to}@c.us`, message: body, linkPreview: true }),
  });
  return r?.idMessage ?? '';
}

/** Instance state: 'authorized' | 'notAuthorized' | 'blocked' | 'sleeping' | ... */
export async function greenState(): Promise<string> {
  const r = await greenCall<{ stateInstance: string }>('getStateInstance');
  return r?.stateInstance ?? 'unknown';
}

/** Base64 PNG of the linking QR (null when already authorized). */
export async function greenQr(): Promise<string | null> {
  try {
    const r = await greenCall<{ type: string; message?: string }>('qr');
    if (r?.type === 'qrCode' && r.message) return r.message;
    return null;
  } catch {
    return null;
  }
}

/** Download an inbound media file by its downloadMessageId → bytes + mime. */
export async function greenDownload(downloadMessageId: string): Promise<{ buffer: Buffer; mime: string; url: string }> {
  const r = await greenCall<{ urlFile: string }>('downloadFile', { query: `idMessage=${encodeURIComponent(downloadMessageId)}` });
  if (!r?.urlFile) throw new Error('greenapi downloadFile returned no urlFile');
  const res = await fetch(r.urlFile);
  if (!res.ok) throw new Error(`greenapi file fetch failed: ${res.status}`);
  const mime = res.headers.get('content-type') ?? 'application/octet-stream';
  return { buffer: Buffer.from(await res.arrayBuffer()), mime, url: r.urlFile };
}
