# SPEC — WhatsApp AI Vendor Escrow Hub

**Working name:** Kolo (Nigerian piggy-bank / safe box)
**Target event:** TCC Hackathon 2026, Tech Conference Calabar — "Solve Local Problems with Global Solutions"
**Team:** 1 builder (web dev, new to Solana)
**Format:** REMOTE 3-day build sprint — **Nov 22, 00:00 → Nov 24, 23:59 WAT**. Submit: public GitHub repo + 5-min public video (4:50–5:10) + form. Judges score ONLY sprint work (Nov 22–24); pre-sprint baseline is committed separately and listed in the README.

---

## 1. What this is

An AI agent on WhatsApp that lets social-commerce vendors **create invoices, receive payments (₦ via Paystack test mode, USDC on Solana devnet), and protect buyers with escrow** — all through chat. Buyers never download anything; they get a web checkout link with buyer-controlled fund release.

**One-line pitch:** _"Buyer-protected checkout for WhatsApp vendors — the vendor's AI bookkeeper that hesitant buyers can trust, because neither the vendor nor the platform can touch the money until delivery is confirmed."_

**How it differs from Xara / Kira / QUICKLY:** those are personal banking bots. This is **merchant escrow infrastructure for social commerce** — nobody is doing buyer-protected, vision-verified checkout for WhatsApp sellers.

---

## 2. Scope

### In (must demo live)
- **Flow A — DM Invoice & Escrow Checkout (core):** vendor texts/voice-notes the bot → AI parses order → checkout link generated → buyer pays (Paystack test ₦) → funds held → vendor uploads dispatch photo → **Vision AI verifies photo vs order** → buyer clicks "Confirm Delivery & Release" → vendor gets payout summary in WhatsApp.
- **Flow D — Conversational Ledger:** vendor asks "how much I make this week across Naira and USDC?" → AI returns aggregated summary (settled vs held-in-escrow).

### Stretch (prep-deployed; live if it works, else screenshot + explorer link)
- **Flow C — P2P USDC Escrow on Solana:** crypto seller locks USDC in an on-chain PDA vault → buyer pays ₦ bank transfer off-chain → seller releases vault → buyer receives USDC. The public **explorer link is the trust proof**.

### Out (one slide in the pitch, zero build hours)
- Flow B — group commerce (@mentions). *Cloud API group access is limited/beta; not bettable. If group access is confirmed during prep, demo Flow A inside a group as a bonus.*
- Web dashboard (the WhatsApp summary message IS the dashboard)
- Dispute-mediation UI (a `DISPUTED` state that freezes release is enough; "reply DISPUTE to freeze")
- FX conversions, USD fiat charges, vendor onboarding flow (one hardcoded vendor phone for the demo)
- Multi-vendor production auth

### The one-line answers for judges
| Question | Answer |
|---|---|
| How is this different from Xara/Kira? | Personal banking bots vs merchant escrow infrastructure for social commerce. |
| You hold funds — regulatory risk? | Non-custodial on-chain vaults for crypto; fiat sits on a licensed PSP merchant account (Paystack) and moves via their Transfer API. We never hold funds outside licensed rails. |
| What if the AI hallucinates a payment? | It can't — AI only perceives; ledger state changes exclusively via signed webhooks or on-chain signatures. |
| Buyer never confirms? | Auto-release timer (24h simulated) unless a dispute is raised. |
| Business model? | 1.5% escrow fee on release. |

---

## 3. Architecture — two tiers, strictly separated

```
        WhatsApp (vendor: text, voice note, photo)
                        │
                        ▼
   ┌─────────────────────────────────────────────┐
   │  TIER 1 — AI PERCEPTION (non-deterministic) │
   │  • Whisper: voice note → text               │
   │  • LLM: intent + entity extraction (Pidgin) │
   │  • GPT-4o Vision: dispatch photo audit      │
   │  • Zod: normalized, typed tool payloads     │
   └───────────────────┬─────────────────────────┘
                       │ tool call only (typed JSON)
                       ▼
   ┌─────────────────────────────────────────────┐
   │  TIER 2 — FINANCIAL ENGINE (deterministic)  │
   │  • State machine: PENDING → FUNDED →        │
   │    DISPATCHED → RELEASED (+DISPUTED/CANCEL) │
   │  • Mutations ONLY via: verified Paystack    │
   │    webhook (HMAC-SHA512) or confirmed       │
   │    Solana RPC signature                     │
   │  • Double-entry ledger writes               │
   └─────────────────────────────────────────────┘
```

**Inviolable rule:** the LLM never writes to the ledger, never transitions escrow state, never moves money. It can only emit typed tool calls that the engine validates and executes.

---

## 4. Tech stack

| Layer | Choice |
|---|---|
| Backend | Node.js LTS + TypeScript, Express |
| DB | MongoDB Atlas (free tier) + Mongoose |
| AI | OpenAI SDK — GPT-4o (chat + tool calls + vision), Whisper (voice) |
| Messaging | Meta WhatsApp Cloud API (test number) |
| Web | Next.js 14 App Router + Tailwind |
| Fiat rail | Paystack **test mode** (Inline checkout in, Transfers API out) |
| Crypto rail | Solana **devnet**; Anchor program (prep-deployed); Wallet Adapter + Phantom |
| Hosting during event | localhost + ngrok/Cloudflare tunnel (webhooks need public URL) |
| Stage safety | `USE_STAGE_MOCKS=true` short-circuits WhatsApp delivery + chain waits |

Devnet USDC note: for full control, **mint our own SPL token labeled USDC on devnet** (we own mint authority) and airdrop to demo wallets in prep. Do not depend on Circle's devnet mint existing.

---

## 5. Data model (Mongoose)

Four collections. Amounts stored as integers in the smallest unit (kobo for NGN, base units for USDC) — no floats in money.

### Vendor
```ts
{
  whatsappNumber: string,        // E.164, unique index
  businessName: string,
  payoutDetails: {
    ngnBankCode?, ngnAccountNumber?, ngnAccountName?,
    paystackRecipientCode?,      // created via Paystack recipient API in prep
    solanaWalletAddress?
  },
  stats: { totalVolumeNgn, totalVolumeUsdc, completedEscrows, disputedEscrows }  // defaults 0
}
```

### Invoice
```ts
{
  slug: string,                  // nanoid, public id in the pay link
  vendorId: ObjectId,
  tradeType: 'COMMERCE' | 'P2P_CRYPTO',
  buyerPhone?: string,
  buyerWalletAddress?: string,   // P2P flow
  items: [{ name, quantity, unitPrice }],
  amountNgn?: number,            // kobo — commerce flow
  amountUsdc?: number,           // base units — P2P flow
  exchangeRate?: number,         // P2P: NGN per USDC
  currency: 'NGN' | 'USDC',
  isEscrow: boolean,
  status: 'PENDING' | 'FUNDED_IN_ESCROW' | 'DISPATCHED' | 'RELEASED' | 'DISPUTED' | 'REFUNDED',
  paymentRail: 'PAYSTACK' | 'SOLANA_PDA',
  externalReference?: string,    // Paystack reference / tx signature
}
```

### Escrow (1:1 with Invoice)
```ts
{
  invoiceId: ObjectId,           // unique
  rail: 'FIAT_PSP' | 'SOLANA_PDA',
  onChainPdaAddress?: string,
  releaseTokenHash: string,      // sha256 of token embedded in buyer's release link
  dispatchProof?: { mediaUrl, aiVerified: boolean, aiSummary, uploadedAt },
  autoReleaseAt?: Date,
  releasedAt?: Date,
  payoutTxReference?: string,
  disputeReason?: string,
}
```

### LedgerEntry
```ts
{
  vendorId, invoiceId,
  type: 'CREDIT' | 'ESCROW_HOLD' | 'FEE' | 'REFUND',
  currency: 'NGN' | 'USDC',
  grossAmount, feeAmount, netAmount,   // integer smallest units
}
```

---

## 6. Escrow lifecycle (state machine)

```
PENDING ──(verified webhook / on-chain deposit)──▶ FUNDED_IN_ESCROW
FUNDED_IN_ESCROW ──(vendor photo + AI verify ≥ threshold)──▶ DISPATCHED
FUNDED_IN_ESCROW | DISPATCHED ──(buyer release token)──▶ RELEASED
FUNDED_IN_ESCROW | DISPATCHED ──("DISPUTE" from either party)──▶ DISPUTED (frozen)
DISPUTED ──(admin resolve)──▶ RELEASED | REFUNDED
PENDING ──(cancel / 24h unfunded)──▶ CANCELLED
FUNDED_IN_ESCROW ──(autoReleaseAt passes, no dispute)──▶ RELEASED
```

Rules:
- Transitions allowed **only** from Tier 2 triggers: valid webhook signature, on-chain confirmed signature, or a valid release token (buyer) / dispute keyword (parties) — never from LLM output.
- AI verification sets `aiVerified` + confidence on the escrow, but **does not itself release funds** — the buyer does (or the timer).
- Release executes payout first, then flips status to `RELEASED` (fixes the PRD bug where status flipped before transfer; on payout error, status stays and we retry).

---

## 7. API surface (Express)

| Method/Path | Purpose |
|---|---|
| `GET /webhooks/whatsapp` | Meta verification handshake (hub.challenge) |
| `POST /webhooks/whatsapp` | Ingress: text / voice / image → AI pipeline → reply. Ack 200 immediately, process async |
| `POST /webhooks/paystack` | `charge.success` → verify HMAC-SHA512 → mark FUNDED, notify both parties |
| `GET /api/invoices/:slug` | Public checkout/release page data (invoice + escrow + vendor name) |
| `POST /api/escrows/:slug/release` | Buyer release: sha256(token) check → payout (Paystack transfer or Solana release) → ledger entries |
| `POST /api/escrows/:slug/dispute` | Either party (phone match) → DISPUTED freeze |
| `POST /api/escrows/:slug/mock-fund` | Stage mock: pretend Paystack fired (behind `USE_STAGE_MOCKS`) |
| `POST /api/dev/tick` | Advance auto-release timers; stage button "simulate +24h" |

## 8. AI tool definitions (Tier 1 → Tier 2 contract)

All validated with Zod before execution. The LLM chooses among:

1. `create_invoice { items[], amountNgn | amountUsdc, currency, isEscrow, buyerPhone? }` — commerce flow; engine creates Invoice+Escrow, returns pay link, bot replies with a summary card.
2. `create_p2p_escrow { usdcAmount, ngnAmount, exchangeRate, counterpartyPhone }` — P2P flow; returns escrow init link.
3. `verify_dispatch { mediaUrl }` — for the active escrow in this thread: GPT-4o vision compares photo against invoice `items[]`; writes `dispatchProof`; replies in chat ("✅ matched: 1× sneaker") and pings buyer's release page.
4. `ledger_summary { timeframe: TODAY|THIS_WEEK|THIS_MONTH|ALL }` — engine aggregates LedgerEntries; LLM phrases the WhatsApp reply (settled vs in-escrow per currency).

Fallback when no tool matches: helpful Pidgin/English reply asking for order details.

---

## 9. Solana escrow program (prep before event — do NOT write on-site)

Adapted from the canonical two-party Anchor escrow pattern. Three instructions:

```
init_escrow(seed, buyer, vendor, mint, amount)  → PDA vault, buyer deposits USDC
release(buyer signature)                        → vault USDC → vendor wallet, minus 1.5% fee to platform PDA
refund(buyer signature)                         → vault USDC → back to buyer (dispute resolution)
```

- Buyer signs `release` from the web release page via Phantom.
- Backend confirms via RPC signature (poll `getSignatureStatuses` — no WebSocket listener needed for MVP).
- Deployed to devnet during prep; the program address is a config value. On-site work = wiring only.

---

## 10. Web portal (Next.js)

**`/pay/[slug]`** — one public page, mobile-first, two states:
1. **Checkout state:** vendor name, items, amount, trust panel (Paystack test badge; or Solana vault address + explorer link), "Pay ₦X" (Paystack Inline) or "Lock USDC" (Wallet Adapter → escrow PDA).
2. **Held state:** escrow status timeline (Funded → Dispatch verified → Awaiting your confirmation), AI dispatch-verification badge, **"Confirm Delivery & Release Funds"** (posts release token), dispute link, countdown to auto-release.

No accounts, no downloads. Everything the buyer needs is in the link.

---

## 11. Repository layout

```
TTc-hack/
├── SPEC.md                  ← this file
├── README.md                ← setup + demo script (add later)
├── backend/
│   ├── src/
│   │   ├── index.ts         # express bootstrap
│   │   ├── config.ts        # env
│   │   ├── db.ts            # mongoose connection
│   │   ├── models/          # Vendor, Invoice, Escrow, LedgerEntry
│   │   ├── routes/          # webhooks (whatsapp, paystack), api (invoices, escrows)
│   │   ├── services/
│   │   │   ├── agent.ts     # Tier 1: whisper + LLM tool router + vision
│   │   │   ├── whatsapp.ts  # Cloud API send helpers + media download
│   │   │   ├── paystack.ts  # init charge, transfers, recipient mgmt
│   │   │   ├── solana.ts    # tx confirmation, PDA derivation, fee calc
│   │   │   └── ledger.ts    # double-entry writes + aggregations
│   │   └── engine/          # Tier 2: state machine transitions (pure functions)
│   └── package.json
├── web/
│   └── (Next.js 14 app: /pay/[slug], wallet adapter, Paystack inline)
└── anchor/
    └── (escrow program; prep-deployed, idl + program-id copied into backend/web)
```

---

## 12. Prep checklist (before the event — every item is de-risking)

**Accounts & keys (all free/test):**
- [ ] Meta developer app + WhatsApp Cloud API **test number** (instant). Save phone number id, token, verify token.
- [ ] Send a test message to the test number; confirm webhook handshake through a tunnel.
- [ ] **Try adding the test number to a group** → resolves the Flow B landmine one way or the other.
- [ ] Paystack account → **test keys**. Create a test transfer recipient for the "vendor". Init one test charge + webhook through tunnel.
- [ ] OpenAI API key (chat + vision + whisper).
- [ ] MongoDB Atlas free cluster.
- [ ] ngrok / Cloudflare Tunnel account.

**Solana (the risky part — front-load it):**
- [ ] Install Anchor/Solana CLI; run the canonical escrow example locally.
- [ ] Modify to our 3 instructions (init/release/refund + 1.5% fee).
- [ ] Deploy to devnet; save program id.
- [ ] Mint own "USDC" SPL token on devnet; airdrop devnet SOL + USDC to two demo wallets (vendor, buyer) in Phantom.
- [ ] One successful manual end-to-end: deposit → release → check explorer link shows vault then transfer.

**Repo:**
- [ ] `/backend` skeleton builds and connects to Mongo; `/web` renders a placeholder `/pay/[slug]`.
- [ ] `USE_STAGE_MOCKS` toggle exists.

**Rules check:**
- [ ] Confirm the hackathon's policy on pre-built code (boilerplate/prep usually fine; core building on-site).

---

## 13. 3-day sprint plan (Nov 22–24, remote)

**Scoring alignment (rubric → our play):**

| Criterion | Pts | How we earn it |
|---|---|---|
| Working Product & Technical Execution | 25 | Full loop works live on video: chat → invoice → pay → AI-verified dispatch → release → ledger |
| Architecture & Code Quality | 20 | Two-tier AI/deterministic separation, typed Zod tool contracts, state machine, no floats in money |
| Scalability & Production Readiness | 15 | **Actually deployed**: web on Vercel, backend on Render, Mongo on Atlas, program on devnet — public URLs |
| Innovation & Local Relevance | 15 | Calabar-specific story: WhatsApp status sellers, "what I ordered vs what I got", Pidgin voice notes |
| Demo Quality & Communication | 10 | 5:00 video: 30s problem → 4min real product → 30s stack/next |
| Social engagement (separate) | 15 | Post video publicly early on Nov 24; rally until Nov 28 noon; only the submitted post counts |

**Day 1 — Sat Nov 22: fiat loop + real WhatsApp (target: Flow A end-to-end)**
- Register for the hackathon BEFORE NOON (form closes).
- Meta app + WhatsApp test number; webhook through the deployed backend (not localhost).
- Deploy: Mongo Atlas cluster → Render backend → Vercel web. Public URLs in env + README.
- Paystack test charge + webhook → FUNDED; buyer release page works. Ledger summary over WhatsApp.
- **Gate:** text the bot a Pidgin order → pay on phone → release → vendor summary. Record it (raw footage for the video).

**Day 2 — Sun Nov 23: crypto rail + vision (target: Flow C + dispatch verification)**
- Deploy anchor program to devnet (`anchor/README.md`), mint demo USDC, wire env.
- USDC deposit via Phantom → vault on explorer → wallet-signed release. P2P flow too if time allows.
- Vision AI dispatch proof: photo in chat → verify → buyer page badge.
- Dispute freeze + auto-release tick button.
- **Gate:** full dual-rail demo works against deployed URLs. Record raw footage.

**Day 3 — Mon Nov 24: polish + submit**
- Morning: README (sprint-work list + AI disclosure), .env examples, seed script, small bugs.
- Midday: record the 5:00 video (script below), re-record until clean; screen-record phones + browser.
- Afternoon: post publicly (tag TCC, #CTCHackathon2026 #TechConferenceCalabar), verify in incognito, submit the form BEFORE 23:59. Then start pushing the post for engagement.

**5-minute video script (matches Demo Quality rubric):**
- 0:00–0:30 — problem: Calabar vendors sell on WhatsApp Status; buyers fear "what I ordered vs what I got"; P2P traders fear fake alerts. Show a real WhatsApp status sale + a scam tweet screenshot.
- 0:30–4:30 — the product, live: vendor Pidgin VOICE NOTE → invoice link → buyer pays (₦ test) → escrow held → vendor snaps package photo → AI verifies → buyer confirms → vendor paid + weekly ledger query. Then the trustless finale: USDC vault locked with the public explorer link.
- 4:30–5:00 — stack in one breath (WhatsApp Cloud API, GPT-4o + Whisper, Paystack, Solana/Anchor, Next.js) + next: groups, naira escrow license, multi-vendor. CTA.

**Video mechanics (rubric is strict):** 4:50–5:10; public post; tag Tech Conference Calabar; hashtags; test link in incognito; never delete/re-upload before Nov 28.

---

## 14. Known risks & mitigations

| Risk | Mitigation |
|---|---|
| Venue Wi-Fi dies | Phone hotspot; `USE_STAGE_MOCKS` path rehearsed; backup video |
| Paystack webhook flakiness on stage | `mock-fund` button; demo can proceed with webhook simulated |
| Solana part breaks | Flow A alone still demos the whole story; Flow C becomes architecture slide + deployed explorer link |
| Voice note parsing fails live | Fall back to typed message — same pipeline, rehearsed both |
| Judge asks "escrow license?" | Honest framing: crypto is non-custodial on-chain; fiat moves inside a licensed PSP (Paystack) — we never hold funds outside PSP rails |
| `invoice._index`-class copy bugs from the PRD | All PRD code treated as reference, not source; engine has unit-checked transitions |

---

## 15. Environment variables

```
# WhatsApp
WHATSAPP_TOKEN=            # Cloud API permanent token (test)
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_VERIFY_TOKEN=
# AI
OPENAI_API_KEY=
# Paystack (test)
PAYSTACK_SECRET_KEY=
PAYSTACK_PUBLIC_KEY=
# DB
MONGODB_URI=
# Solana
SOLANA_RPC_URL=https://api.devnet.solana.com
ESCROW_PROGRAM_ID=
USDC_MINT=
PLATFORM_FEE_PDA=
# App
PUBLIC_BASE_URL=           # tunnel URL, used in links
USE_STAGE_MOCKS=false
```

---

## 16. Definition of done (submission, Nov 24 23:59)

1. Texting the bot a Pidgin order returns a working checkout link.
2. A buyer can pay (test) and funds show as held; vendor is notified in WhatsApp.
3. Dispatch photo is AI-verified and visible to the buyer.
4. Buyer's release actually moves money (test transfer) and writes ledger entries.
5. "How much this week?" returns a correct multi-currency summary.
6. Everything reachable on public deployed URLs (Vercel + Render + Atlas + devnet).
7. README lists sprint-built features + AI tools disclosure.
8. 5:00 video posted publicly, tagged, incognito-tested, form submitted.

## 17. Submission checklist (rubric compliance)

- [ ] Registration form submitted (BEFORE Nov 22 noon)
- [ ] GitHub repo public; README has: what it does, how to run, **sprint-work list**, **AI tools disclosure**
- [ ] Deployed URLs in README (web + API + program id)
- [ ] Video 4:50–5:10, public post, tags TCC + #CTCHackathon2026 #TechConferenceCalabar
- [ ] Link tested in incognito; form submitted before Nov 24 23:59; one submission only
- [ ] Engagement push starts immediately after posting (15% of final score)
