import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config';

/**
 * On-chain verification for the escrow program (see /anchor).
 * The backend NEVER holds keys or signs transactions — the buyer/seller sign
 * in Phantom on the web page. We only derive PDAs and read balances, which is
 * what makes the "non-custodial" claim honest.
 */

export function solanaConfigured(): boolean {
  return Boolean(config.solana.programId && config.solana.usdcMint);
}

let conn: Connection | null = null;
export function connection(): Connection {
  if (!conn) conn = new Connection(config.solana.rpcUrl, 'confirmed');
  return conn;
}

export function programId(): PublicKey {
  return new PublicKey(config.solana.programId);
}

export function usdcMint(): PublicKey {
  return new PublicKey(config.solana.usdcMint);
}

/** escrow PDA seeds: [b"escrow", seed.to_le_bytes()] — must match the Rust program. */
export function deriveEscrowPda(seed: number): PublicKey {
  const seedBuf = Buffer.alloc(8);
  seedBuf.writeBigUInt64LE(BigInt(seed));
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('escrow'), seedBuf], programId());
  return pda;
}

/** vault token account PDA seeds: [b"vault", escrowPda]. */
export function deriveVaultPda(escrowPda: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('vault'), escrowPda.toBuffer()], programId());
  return pda;
}

export async function vaultUiAmount(seed: number): Promise<number> {
  const vault = deriveVaultPda(deriveEscrowPda(seed));
  const res = await connection().getTokenAccountBalance(vault);
  return res.value.uiAmount ?? 0;
}

/** Source of truth for ONCHAIN_FUNDED: the vault really holds the tokens. */
export async function isVaultFunded(seed: number, amountUsdcBase: number): Promise<boolean> {
  try {
    const ui = await vaultUiAmount(seed);
    // uiAmount is in whole USDC; compare in base units (6 decimals)
    return Math.round(ui * 1_000_000) >= amountUsdcBase;
  } catch {
    // token account may not exist yet (not funded)
    return false;
  }
}

/** Source of truth for release: vault is empty / account closed. */
export async function isVaultDrained(seed: number): Promise<boolean> {
  try {
    const ui = await vaultUiAmount(seed);
    return ui <= 0.000001;
  } catch {
    return true; // account gone = fully drained & closed
  }
}
