# Deployment Guide (Sprint Day 1)

Goal: everything on public URLs so the README can say "deployed" and the video shows real links. Free tiers only.

## 1. MongoDB Atlas (5 min)

1. Create a free M0 cluster → Database Access: user `kolo` + password → Network Access: allow `0.0.0.0/0` (demo).
2. Copy the connection string: `mongodb+srv://kolo:<pass>@cluster0.xxxxx.mongodb.net/kolo`
3. Use it as `MONGODB_URI` everywhere below.

## 2. Backend on Render (10 min)

1. Push the repo to GitHub first (public for submission).
2. Render → New → Web Service → connect the repo.
3. Settings:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Environment → add ALL vars from `backend/.env.example` (Mongo = Atlas string, `PUBLIC_BASE_URL` = the Render URL, `USE_STAGE_MOCKS=false`).
5. Deploy. Health check: `https://<app>.onrender.com/api/health`.

> Free-tier note: the service sleeps after inactivity. Meta retries webhooks and our
> `confirm-fiat` endpoint is a server-verified fallback, so a sleeping service is a
> nuisance, not a break. Ping `/api/health` before the demo.

## 3. Web on Vercel (5 min)

1. Vercel → New Project → import repo → **Root Directory:** `web` (framework auto-detected).
2. Environment vars: `NEXT_PUBLIC_API_URL=https://<app>.onrender.com`, `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY=pk_test_...`
3. Deploy. Checkout page: `https://<app>.vercel.app/pay/<slug>`.

## 4. WhatsApp Cloud API (15 min)

1. developers.facebook.com → Create App → Business → add **WhatsApp** product.
2. Use the **test number**. Copy the permanent token (App Setup → generate token), Phone Number ID, and set your own `WHATSAPP_VERIFY_TOKEN`.
3. Put them in Render env vars (redeploy).
4. WhatsApp → Configuration → Edit webhook: Callback `https://<app>.onrender.com/webhooks/whatsapp`, verify token as set → Verify and Save → subscribe to `messages`.
5. From your phone (any number, up to 5): send a message to the test number → bot replies within the 24h window.
6. **While here:** try adding the test number to a WhatsApp group. Settles the Flow-B question — if groups work, it's a bonus demo, not a scored feature.

## 5. Paystack test (already have keys?)

- Dashboard → Settings → API Keys → Test Secret + Public keys.
- Webhook URL: `https://<app>.onrender.com/webhooks/paystack`.
- Run `npm run seed` locally with the Render `MONGODB_URI` + test keys to create the vendor's transfer recipient (or set the vars and run seed against Atlas).

## 6. Solana devnet (Sprint Day 2)

Follow `anchor/README.md` fully (deploy program, mint demo USDC, fund wallets, fill `ESCROW_PROGRAM_ID`, `USDC_MINT`, `PLATFORM_FEE_WALLET` in Render env). Nothing here needs a server — the program lives on-chain.

## 7. Final checklist

- [ ] `/api/health` returns ok on Render URL
- [ ] Bot replies on WhatsApp to a real message
- [ ] A checkout link from the bot opens on the Vercel URL
- [ ] README "Deployed" section filled with the actual URLs
