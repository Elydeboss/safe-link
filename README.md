# Kolo 🔒

**Buyer-protected checkout for WhatsApp vendors** — an AI agent that invoices, takes payment (₦ / USDC), holds funds in escrow, AI-verifies dispatch photos, and releases on buyer confirmation. Calabar Build Hackathon 2026.

Read [`SPEC.md`](./SPEC.md) first — it is the source of truth for scope, architecture, and the build plan.

## Layout

| Folder | What it is |
|---|---|
| `backend/` | Express + TypeScript: WhatsApp webhook, AI agent (Tier 1), deterministic escrow engine (Tier 2), Paystack + Solana integrations |
| `web/` | Next.js 14 checkout/release page (`/pay/[slug]`) — the buyer's zero-download surface |
| `anchor/` | Solana escrow program (non-custodial PDA vault). **Deploy in prep, not on-site** — see `anchor/README.md` |

## Quick start (backend)

```bash
cd backend
cp .env.example .env         # fill WHATSAPP_*, OPENAI_API_KEY, PAYSTACK_* (test keys)
npm install
npm run dev                  # listens on :4000
```

Expose webhooks through a tunnel (Meta + Paystack need a public URL):

```bash
ngrok http 4000
# then in .env: PUBLIC_BASE_URL=https://<your-tunnel>.ngrok.app
```

Register the webhook in Meta App Dashboard → WhatsApp → Configuration:
- Callback URL: `https://<tunnel>/webhooks/whatsapp`
- Verify token: the value of `WHATSAPP_VERIFY_TOKEN`

Seed the demo vendor (where fiat payouts go):

```bash
npm run seed
```

### Smoke test with zero keys

```bash
USE_STAGE_MOCKS=true npm run dev
```
then `curl -X POST localhost:4000/api/escrows/<slug>/mock-fund` after creating an invoice — the full flow runs with mocked WhatsApp + payouts. This is also the stage-demo safety net (SPEC §4).

## Quick start (web)

```bash
cd web
cp .env.local.example .env.local   # API URL + Paystack PUBLIC test key
npm install
npm run dev                        # http://localhost:3000
```

## The two demo flows

1. **Vendor (WhatsApp):** "Invoice 2 Airpods 60k for Chioma" → bot replies with a checkout link → forward to buyer.
2. **Buyer (browser):** pay (Paystack test / Phantom devnet USDC) → watch escrow hold → vendor sends package photo to the bot → AI verifies → buyer taps *Confirm delivery & release* → vendor paid, ledger updated.

P2P stretch: "sell 100 USDC for 165k" → USDC locked on-chain (public explorer link = the trust proof) → buyer pays naira → seller releases from the vault.

## Prep-before-event checklist

See **SPEC §12** — the short version:

- [ ] Meta test number + webhook handshake through tunnel
- [ ] Try the test number in a group (settles the Flow-B question)
- [ ] Paystack test charge + webhook through tunnel
- [ ] `anchor/README.md` end to end: deploy program, mint demo USDC, smoke deposit→release
- [ ] `npm run seed` for the demo vendor
- [ ] Rehearse with `USE_STAGE_MOCKS=true`

## Stage safety

- `USE_STAGE_MOCKS=true` (backend) — WhatsApp sends and payouts become logs
- `POST /api/escrows/:slug/mock-fund` — pretend the payment webhook fired
- `POST /api/dev/tick` — advance the 24h auto-release timer

## Honest limitations (say these on stage if asked)

- Fiat "escrow" = funds settle to our Paystack merchant account; we pay out via their Transfer API. Non-custodial only describes the crypto rail.
- Release links are capability URLs (`?k=`); no buyer accounts exist in the MVP.
- Disputes freeze funds; resolution is admin-mediated in v1 (the Rust program's `cancel` supports on-chain refunds).
