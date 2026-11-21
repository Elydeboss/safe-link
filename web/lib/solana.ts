import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { Buffer } from 'buffer';

/**
 * Minimal client for the kolo_escrow program. Instructions are hand-encoded
 * (Anchor 8-byte discriminator + borsh LE u64 args) so there is no IDL to
 * keep in sync. Account order MUST match /anchor/src/lib.rs.
 */

declare global {
  interface Window {
    solana?: { isPhantom?: boolean; publicKey?: { toString(): string }; connect(): Promise<{ publicKey: { toString(): string } }>; signAndSendTransaction(tx: Transaction): Promise<{ signature: string }> };
  }
}

export const USDC_DECIMALS = 6;

function u64le(n: number): Uint8Array {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setBigUint64(0, BigInt(n), true);
  return new Uint8Array(buf);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Anchor discriminator = first 8 bytes of sha256("global:<snake_case_name>"). */
async function disc(nameSnake: string): Promise<Uint8Array> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`global:${nameSnake}`)));
  return hash.slice(0, 8);
}

export function deriveEscrowPda(programId: PublicKey, seed: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('escrow'), Buffer.from(u64le(seed))], programId);
  return pda;
}

export function deriveVaultPda(programId: PublicKey, escrowPda: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('vault'), escrowPda.toBuffer()], programId);
  return pda;
}

export function escrowExplorerUrl(pda: string): string {
  return `https://explorer.solana.com/address/${pda}?cluster=devnet`;
}

export async function connectPhantom(): Promise<PublicKey> {
  if (!window.solana?.isPhantom) throw new Error('Phantom wallet not found. Install the Phantom browser extension.');
  const res = await window.solana.connect();
  return new PublicKey(res.publicKey.toString());
}

function conn(rpcUrl: string): Connection {
  return new Connection(rpcUrl, 'confirmed');
}

async function send(rpcUrl: string, tx: Transaction): Promise<string> {
  if (!window.solana) throw new Error('Phantom not connected');
  const { signature } = await window.solana.signAndSendTransaction(tx);
  await conn(rpcUrl).confirmTransaction(signature, 'confirmed');
  return signature;
}

/** Buyer/seller locks USDC: init_escrow + deposit in one tx. */
export async function depositToEscrow(opts: {
  rpcUrl: string;
  programId: string;
  usdcMint: string;
  seed: number;
  amountBaseUnits: number;
}): Promise<string> {
  const program = new PublicKey(opts.programId);
  const mint = new PublicKey(opts.usdcMint);
  const depositor = await connectPhantom();
  const connection = conn(opts.rpcUrl);

  const escrowPda = deriveEscrowPda(program, opts.seed);
  const vaultPda = deriveVaultPda(program, escrowPda);
  const depositorAta = getAssociatedTokenAddressSync(mint, depositor);

  const data = concat(await disc('init_escrow'), u64le(opts.amountBaseUnits), u64le(opts.seed));

  const ix = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: escrowPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: depositor, isSigner: true, isWritable: true },
      { pubkey: depositorAta, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.feePayer = depositor;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return send(opts.rpcUrl, tx);
}

/** Release authority (depositor) releases: net -> recipient, 1.5% fee -> platform. */
export async function releaseEscrow(opts: {
  rpcUrl: string;
  programId: string;
  usdcMint: string;
  seed: number;
  recipientWallet: string;
  platformFeeWallet: string;
}): Promise<string> {
  const program = new PublicKey(opts.programId);
  const mint = new PublicKey(opts.usdcMint);
  const releaser = await connectPhantom();
  const connection = conn(opts.rpcUrl);

  const escrowPda = deriveEscrowPda(program, opts.seed);
  const vaultPda = deriveVaultPda(program, escrowPda);

  const tx = new Transaction();

  // recipient ATA (create first if missing)
  const recipientAta = getAssociatedTokenAddressSync(mint, new PublicKey(opts.recipientWallet));
  if (!(await connection.getAccountInfo(recipientAta))) {
    tx.add(createAssociatedTokenAccountInstruction(releaser, recipientAta, new PublicKey(opts.recipientWallet), mint));
  }
  // platform fee ATA (create first if missing)
  const feeAta = getAssociatedTokenAddressSync(mint, new PublicKey(opts.platformFeeWallet));
  if (!(await connection.getAccountInfo(feeAta))) {
    tx.add(createAssociatedTokenAccountInstruction(releaser, feeAta, new PublicKey(opts.platformFeeWallet), mint));
  }

  const data = concat(await disc('release'), u64le(opts.seed));
  const ix = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: escrowPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: recipientAta, isSigner: false, isWritable: true },
      { pubkey: feeAta, isSigner: false, isWritable: true },
      { pubkey: releaser, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
  tx.add(ix);

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.feePayer = releaser;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return send(opts.rpcUrl, tx);
}

/** Depositor cancels and gets 100% back. */
export async function cancelEscrow(opts: { rpcUrl: string; programId: string; usdcMint: string; seed: number }): Promise<string> {
  const program = new PublicKey(opts.programId);
  const mint = new PublicKey(opts.usdcMint);
  const owner = await connectPhantom();
  const connection = conn(opts.rpcUrl);

  const escrowPda = deriveEscrowPda(program, opts.seed);
  const vaultPda = deriveVaultPda(program, escrowPda);
  const ownerAta = getAssociatedTokenAddressSync(mint, owner);

  const data = concat(await disc('cancel'), u64le(opts.seed));
  const ix = new TransactionInstruction({
    programId: program,
    keys: [
      { pubkey: escrowPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: ownerAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });

  const tx = new Transaction().add(ix);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.feePayer = owner;
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return send(opts.rpcUrl, tx);
}
