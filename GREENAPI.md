# GREENAPI.md — WhatsApp transport via Green API gateway

**Status: SPEC (ready to implement · Night 1)** · Owner: elijah · Related: `SPEC.md` §4, `DEPLOY.md`

## 1. Why

Meta Cloud API phone verification has been blocked for 2+ days and threatens the "WhatsApp-native" demo. **Green API** (green-api.com, est. 2015) is a WhatsApp gateway built on the linked-device (WhatsApp Web) protocol: we link a WhatsApp number by QR scan — no Meta approval of any kind — and send/receive through a plain REST API.

- Free "Developer" tariff: unlimited send/receive **within 3 chats** — exactly demo scale (vendor line + buyer line + spare). Limits reset monthly.
- `ReceiveNotification` polling needs **no public URL** — works on localhost immediately; no ngrok.
- The linked number can message first — no 24h window, no templates.

**Honest framing (README/pitch):** transport layer is pluggable — Meta Cloud API integration exists (`routes/whatsapp.ts`) but is gated on Meta's verification; the live demo runs on the Green API gateway via a disposable demo SIM. This is disclosed as a limitation (unofficial protocol, ToS risk), not hidden.

## 2. Non-goals

- No changes to agent pipeline, escrow commands/projections, web app, or the Meta webhook route (stays mounted & functional).
- No group chats (`@g.us`) — ignore. No outbound media (all our replies are text/links). No delivery-receipt processing.
- No Green API SDK dependency — plain `fetch` against 4 endpoints.

## 3. Provider model

`WHATSAPP_PROVIDER` selects the transport inside the `whatsapp.ts` facade:

| Value | Egress (`sendText`) | Ingress | When |
|---|---|---|---|
| `greenapi` | Green API `sendMessage` | poller (this spec) | demo, until Meta unblocks |
| `meta` | Meta Cloud API (current code) | webhook `/webhooks/whatsapp` | production path |
| `mock` | console log (current behavior) | none | tests / no keys |

Precedence when `WHATSAPP_PROVIDER` is unset: `greenapi` if `GREEN_API_INSTANCE_ID`+`GREEN_API_API_TOKEN` set → `meta` if `WHATSAPP_TOKEN` set → `mock`. `USE_STAGE_MOCKS=true` still forces mock regardless (stage safety net stays supreme).

**Contract:** the facade keeps its current exported signatures — `sendText(to, body)`, `downloadMedia(ref)`, `notify(to, body)` — so no caller changes anywhere. `downloadMedia(ref)` gains a provider branch: Meta path takes a media id; Green API path takes a `downloadMessageId` and internally resolves the temp URL then fetches bytes. New export: `whatsappProvider(): 'greenapi'|'meta'|'mock'` for `/api/health`.

## 4. Config additions (`backend/src/config.ts`, `.env`, `.env.example`)

```
WHATSAPP_PROVIDER=            # greenapi | meta | mock (auto-detected if empty — see §3)
GREEN_API_BASE_URL=https://api.green-api.com
GREEN_API_INSTANCE_ID=        # from console.green-api.com → instance page
GREEN_API_API_TOKEN=          # same page ("API token")
GREEN_API_POLL_MS=3000        # poller interval
```

`config.greenApi = { baseUrl, instanceId, apiToken, pollMs }`; `warnMissingConfig()` gains: warn if provider=greenapi but credentials missing.

## 5. Architecture

```
                     ┌──────────────────────────────────────────┐
 vendor's WhatsApp → │  greenapiPoller (3s loop, index.ts boot) │
 buyer's WhatsApp  ← │  ReceiveNotification → dispatch → Delete │
                     └───────────────┬──────────────────────────┘
                                     │ same dispatch semantics as routes/whatsapp.ts
              text ──────────────────┼→ handleText(phone, senderName, text)
              image ─────────────────┼→ downloadMedia → latestAwaitingDispatch → verifyDispatch
              audio (voice note) ────┼→ downloadMedia → transcribeVoice → handleText
                                     │
              ALL replies & buyer pings ← notify()/sendText() via provider facade
```

## 6. Module specs

### 6.1 NEW `backend/src/services/greenapi.ts` — REST client

Base URL pattern: `{baseUrl}/waInstance{instanceId}/{method}/{apiToken}`.

```ts
/** POST sendMessage  body { chatId: `${to}@c.us`, message, linkPreview: true } → { idMessage } */
export async function greenSendText(to: string, body: string): Promise<string>

/** GET getStateInstance → { stateInstance: 'authorized'|'notAuthorized'|'blocked'|... } */
export async function greenState(): Promise<string>

/** GET downloadFile?idMessage={downloadMessageId} → { urlFile } (temp URL) → fetch bytes.
 *  Returns { buffer, mime, url } — same shape as the Meta downloadMedia. */
export async function greenDownload(downloadMessageId: string): Promise<{ buffer: Buffer; mime: string; url: string }>
```

Error policy: non-2xx → throw `Error('greenapi {method} failed: {status} {body≤300}')` (mirrors the Meta client). No retries inside the client; callers own retry policy.

⚠️ Verify-then-lock: confirm `downloadFile` param name (`idMessage`) against the live instance on first integration (docs: `/docs/api/receiving/files/DownloadFile/`). Budget: 500 calls/month on free tier.

### 6.2 MODIFY `backend/src/services/whatsapp.ts` — provider facade

- Keep file as the Meta implementation; rename internals if helpful.
- `sendText`: switch on provider — `greenapi` → `greenSendText`; `meta` → current `graph()` call; `mock`/`USE_STAGE_MOCKS`/no-creds → current console-log behavior.
- `downloadMedia(ref)`: `greenapi` → `greenDownload(ref)`; else current Meta path.
- `notify`: unchanged logic (still fire-and-forget through `sendText`).
- Add `export function whatsappProvider()`.

### 6.3 NEW `backend/src/services/greenapiPoller.ts` — ingress

```ts
export function startGreenApiPoller(): void   // idempotent; logs '[greenapi] poller started (interval Xms)'
export function stopGreenApiPoller(): void    // for tests
```

Loop (one in-flight poll at a time — no overlap):

1. `GET receiveNotification` → `204`/empty body → sleep `pollMs`, continue. Else `{ receiptId, body }`.
2. Inspect `body.typeWebhook`:
   - `incomingMessageReceived` → dispatch (§7).
   - anything else (`outgoingMessageReceived`, `outgoingMessageStatus`, `stateInstanceChanged`, …) → log at debug level only, then delete.
3. **Always** `DELETE deleteNotification/{receiptId}` afterwards (ack), even on dispatch error — a poison message must not wedge the queue; log the error loudly instead.
4. Loop errors: catch, log `[greenapi] poll error`, exponential backoff 3s→30s, reset on success. The poller must never crash the process.
5. Skip group chats: `senderData.chatId.endsWith('@g.us')` → delete + ignore.
6. Dedupe: keep an in-memory `Set<idMessage>` (last 500) — protects against any redelivery edge; `routes/whatsapp.ts` keeps its own `seen` set.

Boot check: on `startGreenApiPoller`, call `greenState()` once; if not `authorized`, log a loud warning with the QR instructions (`GET /waInstance{id}/qr/{token}` returns a base64 QR; or console.green-api.com → instance → scan) — but keep polling (state may change once the user scans).

### 6.4 MODIFY `backend/src/index.ts`

After `startProjections()`: `if (whatsappProvider() === 'greenapi') startGreenApiPoller();`
`/api/health` response gains `{ whatsapp: { provider, state? } }` (state fetched opportunistically & cached 60s — health must stay fast).

## 7. Inbound mapping (from live docs)

```jsonc
{
  "typeWebhook": "incomingMessageReceived",
  "timestamp": 1764000000,
  "idMessage": "F7AEC1B7086E...",
  "senderData": {
    "chatId": "2348012345678@c.us",
    "sender": "2348012345678@c.us",
    "senderName": "Ada",
    "senderContactName": "Ada Thrift"
  },
  "messageData": { "typeMessage": "textMessage", "textMessage": "abeg invoice 2 airpods 60k for Chioma" }
}
```

Dispatch table (identical semantics to `routes/whatsapp.ts`):

| `messageData.typeMessage` | Action |
|---|---|
| `textMessage` / `extendedTextMessage` | `handleText(phone, senderContactName \|\| senderName \|\| 'Vendor', text)` → reply via `sendText(phone, reply)` |
| `imageMessage` (or any media that is a photo) | `greenDownload(messageData.imageMessage.downloadMessageId)` → `latestAwaitingDispatch(phone)` → none: coach-reply; found: `verifyDispatch(slug, {buffer, mime, url})` → reply verified ✅ / warning ⚠️ |
| `audioMessage` (voice note) | download → `transcribeVoice(buffer, mime)` → log transcript → `handleText(phone, name, transcript)` → reply |
| everything else | polite "I can't read that yet — send text, a voice note, or a photo 🙏" |

`phone` = `senderData.chatId` with `@c.us` stripped. Outbound `chatId` = `${phone}@c.us`.

## 8. Identity & the 3-chat budget

The linked WhatsApp number **is SafeLink's business line** (the demo SIM). Vendors DM it; it replies; buyers get `notify()` pings from the same line. Free-tier budget: **vendor chat + buyer chat + 1 spare**. Demo protocol: one vendor SIM (Ada) and one buyer SIM — do not wander the demo across extra numbers; limits reset the 1st of each month.

## 9. Runbook — going live tonight

1. Register: `console.green-api.com/registration` (email).
2. Create instance → tariff **Developer** (free). Note `idInstance` + API token from the instance page.
3. `backend/.env`: `WHATSAPP_PROVIDER=greenapi`, `GREEN_API_INSTANCE_ID=…`, `GREEN_API_API_TOKEN=…`.
4. **Enable notifications** (fresh instances are mute — this bit us once): `POST {base}/waInstance{id}/setSettings/{token}` body `{"incomingWebhook":"yes","markIncomingMessagesReadedOnReply":"yes"}`.
5. `npm run dev` → boot log shows provider + state (`notAuthorized` expected).
5. Scan QR: console instance page → QR tab (or `GET /waInstance{id}/qr/{token}`) — on the **demo SIM's** WhatsApp: *Settings → Linked devices → Link a device*. State flips to `authorized`.
6. From the vendor SIM, WhatsApp the SafeLink line: `"Abeg create invoice for 2 Airpods Pro, 60k total, for Chioma. With escrow abeg"` → reply with `/pay/…?k=…` link arrives in-chat.
7. Buyer test-card payment → buyer ping arrives; vendor photo → vision verdict reply.

**Which SIM:** a secondary number (the one that failed Meta verification is ideal). Never link a primary personal line — unofficial-protocol ban risk is low at human volume but not zero.

## 10. Test plan & acceptance criteria

- `npx tsc --noEmit` clean; `smoke.ts` still green (mock path untouched).
- Poller unit sanity: state unauthorized → polls without crash; poison `messageData` → deleted, loop survives (manual: send a sticker).
- Live checklist (= §9 steps 6–7) + voice note in Pidgin → transcript → invoice.
- **Definition of done:** a real WhatsApp text from the vendor SIM produces a checkout link reply in-chat, and the funded→photo→verify→release pings land on both SIMs, with `/api/health` reporting `{"whatsapp":{"provider":"greenapi","state":"authorized"}}`.

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Number ban (ToS) | demo SIM only; 1:1 human-volume chats; no bulk sends; disclose in README |
| Session drop (phone offline) | keep SIM charged+online; `Reboot` endpoint + console; health shows state |
| Poison notification wedges queue | delete-after-process always (§6.3.3) |
| 4th chat breaches free tier | §8 protocol; spare chat reserved for judges |
| Green API outage mid-demo | webchat (`/chat`) is the recorded fallback — same brain |
| `DownloadFile` field-name drift | verify on first live instance (§6.1 note) before wiring vision path |

## 12. Doc updates shipped with the implementation

- `README.md`: WhatsApp checkbox flips to "✅ live via Green API gateway (Meta Cloud API integration also implemented, pending Meta verification)" + AI/limitation disclosure line.
- `backend/.env.example` §4 vars; `DEPLOY.md` Render env list gains the 4 GREEN_API vars.
- Sprint commit message references this spec.
