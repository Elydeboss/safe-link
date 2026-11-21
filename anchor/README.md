# Kolo Escrow — Solana Program (PREP WORK)

Non-custodial USDC escrow for WhatsApp commerce. **Deploy this BEFORE the
hackathon** — on-site you only wire the bot to it (SPEC §12).

Three instructions, no admin keys, the platform can never move funds:

| Instruction | Who signs | What happens |
|---|---|---|
| `init_escrow(amount, seed)` | depositor | PDA vault created, USDC locked in |
| `release(seed)` | depositor (release authority) | 98.5% → recipient, 1.5% → platform fee, vault closed |
| `cancel(seed)` | depositor | 100% back to depositor, vault closed |

For commerce orders the depositor is the **buyer**; for P2P trades it is the
**crypto seller**. In both cases only the depositor can release — the platform
holds no keys.

## One-time setup

```bash
# 1. Install toolchains if missing
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
avm install 0.30.1 && avm use 0.30.1   # anchor

# 2. Generate the program keypair and note the address
solana-keygen new -o target/deploy/kolo_escrow-keypair.json --no-bip39-passphrase
solana-keygen pubkey target/deploy/kolo_escrow-keypair.json
```

Then put that address in **two places**:
1. `Anchor.toml` → `[programs.devnet] kolo_escrow = "<ADDRESS>"`
2. `src/lib.rs` → `declare_id!("<ADDRESS>")` (replace the placeholder)

```bash
# 3. Wallet + airdrop (devnet)
solana config set --url devnet
solana-keygen new --no-bip39-passphrase        # ~/.config/solana/id.json
solana airdrop 2

# 4. Build & deploy
anchor build
anchor deploy --provider.cluster devnet
solana program show <ADDRESS>   # confirm live
```

## Mint the demo USDC (we control the mint — never depend on Circle's devnet USDC)

```bash
USDC_MINT=$(spl-token create-token --decimals 6 --url devnet | awk '/Creating/{print $3}')
echo "USDC_MINT=$USDC_MINT"

# Fund the two demo wallets (import both into Phantom first)
spl-token create-account $USDC_MINT --url devnet
spl-token mint $USDC_MINT 1000 --url devnet
spl-token transfer $USDC_MINT 500 <BUYER_WALLET> --url devnet --fund-recipient --allow-unfunded-recipient
```

## Fill the backend env, then seed

```bash
# backend/.env
ESCROW_PROGRAM_ID=<ADDRESS>
USDC_MINT=$USDC_MINT
PLATFORM_FEE_WALLET=<A_WALLET_YOU_CONTROL>
```

Create the platform fee ATA once so the first release doesn't need to:

```bash
spl-token create-account $USDC_MINT --url devnet --owner <PLATFORM_FEE_WALLET_KEYPAIR>
```

## Smoke test (must pass before the event)

Deposit → release → explorer:

```bash
# easiest: use the web page (/pay/<slug> from a USDC invoice) and confirm:
# 1. Phantom popup shows the deposit, vault appears on explorer (link on page)
# 2. After release, recipient got net, fee wallet got 1.5%, vault account closed
```

## Verify PDAs match

Backend and web derive both PDAs as:
- escrow: `[b"escrow", seed.to_le_bytes()]`
- vault: `[b"vault", escrow_pda]`

If you change seeds in the Rust program, change `backend/src/services/solana.ts`
and `web/lib/solana.ts` to match.
