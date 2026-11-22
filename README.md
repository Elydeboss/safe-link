# SafeLink 🔒

**Escrow you can chat with.** An AI agent that invoices buyers, collects payment (₦ or USDC), holds the money until delivery is confirmed, and pays the vendor — all started from a chat message.

Built for **TCC Hackathon 2026** (Tech Conference Calabar) — *"Solve Local Problems with Global Solutions."*

> Calabar vendors run real businesses through WhatsApp Status and DMs. Buyers hesitate because of *"what I ordered vs what I got"* scams, and P2P traders fear fake bank alerts. SafeLink is the AI escrow agent living in the chat app they already use: the vendor's bookkeeper, and the buyer's proof that **nobody — vendor or platform — can touch the money until delivery is confirmed.**

📖 Full architecture & build plan: [`SPEC.md`](./SPEC.md) · Deploy runbook: [`DEPLOY.md`](./DEPLOY.md)

---

## How it works

```
  Vendor (chat)                         Buyer (browser)
  ─────────────                         ───────────────
  "Invoice 2 Airpods 60k for Chioma"
        │                                       │
        ▼                                       ▼
  ┌─────────────────┐    checkout link    ┌─────────────────┐
  │   AI AGENT      │ ──────────────────▶ │  /pay/[slug]    │
  │  (tool calls)   │                     │  pay ₦ (Paystack)│
  └────────┬────────┘                     │  or USDC (Solana)│
           │                              └────────┬────────┘
           │ invoice event                        │ funds HELD
           ▼                                      ▼
  ┌──────────────────────────────────────────────────────────┐
  │            EVENT-SOURCED ESCROW CORE (evtstore)          │
  │   invoiceCreated → fiatFunded → dispatchVerified         │
  │        → fundsReleased        (immutable, replayable)    │
  └────────┬───────────────────────────────────┬─────────────┘
           │                                   │
           ▼                                   ▼
  vendor sends package photo        buyer taps "Confirm delivery"
  AI VISION verifies it matches     (or 24h auto-release)
  the invoice line items                    │
                                           ▼
                                  payout FIRST, then status flip
                                  vendor paid · ledger updated
```

**Every state change is an immutable event.** Commands validate intent, the aggregate folds events into order state, and projections materialize the queryable read models — the entire ledger can be rebuilt by replaying the stream.

## Features built during the sprint (Nov 22–24, 2026)

> Per the participant guide, judges score sprint work. This list is kept accurate as the sprint progresses. *(The repo was initialized with a scaffold baseline on Nov 21 — models, state-machine skeletons, route stubs — committed separately as "Pre-sprint baseline".)*

- [x] **Event-sourced escrow core** ([evtstore](https://seikho.github.io/evtstore/)) — commands are the only writers; Mongoose docs are projections; verified end-to-end by an automated smoke test (invoice → fund → wrong-token-reject → release → exact 1.5% fee → ledger)
- [x] **AI agent pipeline** — LLM intent parsing → typed tool calls → deterministic engine executes; provider-pluggable (Gemini / Groq / OpenAI via one config), Nigerian-Pidgin-friendly, voice-note transcription path included
- [x] **Web chat surface (`/chat`)** — the same agent pipeline in the browser (built while Meta's phone verification is blocked; the WhatsApp webhook runs the identical code path and plugs in when Meta unblocks)
- [x] **Paystack (test mode) fiat escrow** — charge → HMAC-verified webhook → `FUNDED_IN_ESCROW` → buyer-controlled release via capability token → **payout executes before status flips**
- [x] **Buyer checkout page `/pay/[slug]`** — Paystack inline checkout + Solana/Phantom USDC deposit + live escrow status + AI dispatch-proof badge + release/dispute controls
- [x] **Vision-AI dispatch verification** — vendor snaps the package/waybill, the model audits it against the invoice line items, the buyer sees the verdict
- [x] **Conversational multi-currency ledger** — "how much I don make this week?" → settled vs held, per currency
- [x] **Solana Anchor escrow program** (`anchor/`) — non-custodial PDA vault + token escrow, compiles clean; deploy to devnet scheduled Day 2
- [ ] WhatsApp Cloud API **live** ingress (blocked on Meta phone verification — identical pipeline already runs on `/chat`)
- [ ] Solana **devnet deployment** + demo USDC flow end-to-end
- [ ] Cloud deploys (Atlas → Render → Vercel) + 5-min demo video

## AI tools disclosure

- **OpenCode agent (GLM, Z.ai)** — code generation, scaffolding, debugging, and test writing throughout the sprint, directed by the builder.
- Runtime AI **inside the product**: Google **Gemini** (free tier) for intent parsing, dispatch-photo auditing, and voice transcription — wired through an OpenAI-compatible interface so the provider is swappable (Groq/OpenAI supported) without code changes.

## The two demo flows

1. **Vendor (chat):** *"Abeg invoice 2 Airpods Pro, 60k total, for Chioma with escrow"* → bot replies with a checkout link → vendor forwards it to the buyer.
2. **Buyer (browser):** pays (Paystack test card / Phantom devnet USDC) → funds show as **held** → vendor sends the package photo in chat → **AI verifies it** → buyer taps *Confirm delivery & release* → vendor paid, ledger updated.

**P2P stretch:** *"I wan sell 100 USDC for 165k"* → USDC locked in the on-chain vault (public explorer link = the trust proof) → buyer pays naira → seller releases the USDC.

## Repo layout

| Folder | What it is |
|---|---|
| `backend/src/events/` | Event-sourced core: events, aggregate fold, commands, read-model projections |
| `backend/src/services/` | AI agent, escrow orchestration, Paystack, Solana, WhatsApp, ledger |
| `backend/src/routes/` | Webhooks (WhatsApp/Paystack) + REST API + `/api/chat` |
| `web/` | Next.js: `/chat` (agent surface) + `/pay/[slug]` (buyer checkout) |
| `anchor/` | Solana escrow program (non-custodial PDA vault) — deploy guide in `anchor/README.md` |

## Quick start

**Backend** (Express + TypeScript, port 4000):

```bash
cd backend
cp .env.example .env      # fill PAYSTACK_* (test keys), AI_API_KEY (Gemini), etc.
npm install
npm run dev
```

**Web** (Next.js, port 3000):

```bash
cd web
cp .env.local.example .env.local   # API URL + Paystack PUBLIC test key
npm install
npm run dev
```

**Smoke test — zero API keys needed** (local MongoDB):

```bash
cd backend && npx tsx src/scripts/smoke.ts
# invoice → fund → wrong-token-reject → release → fee math → ledger ✅
```

### Stage/demo safety

- `USE_STAGE_MOCKS=true` — WhatsApp sends and payouts become console logs
- `POST /api/escrows/:slug/mock-fund` — pretend the payment webhook fired
- `POST /api/dev/tick` — advance the 24h auto-release timer

## Design decisions worth asking about

- **Money is integers only** — kobo for ₦, base-6 units for USDC. No floats, ever.
- **Payout before status flip** — a failed transfer can never swallow escrowed money.
- **Capability URLs** — the buyer's release link carries a token whose **sha256 hash** is the only thing stored; plaintext exists solely in the link.
- **The LLM never touches money** — AI parses intent and audits photos; every state change goes through validated commands.
- **Event sourcing** — the full audit trail (`invoiceCreated → … → fundsReleased`) is queryable in Mongo and replayable.

## Honest limitations

- Fiat "escrow" = funds settle to our Paystack **merchant account** (licensed PSP); payouts run through their Transfer API. "Non-custodial" describes the **crypto rail only**.
- Paystack is in **test mode** for the hackathon — real money movement requires KYB onboarding (post-hackathon).
- Release links are capability URLs (`?k=`); buyer accounts don't exist in the MVP.
- Disputes **freeze** funds; resolution is admin-mediated in v1 (the on-chain program's `cancel` path supports protocol-level refunds).
- WhatsApp ingress is built but blocked on Meta's phone verification — the `/chat` surface runs the identical agent pipeline meanwhile.
