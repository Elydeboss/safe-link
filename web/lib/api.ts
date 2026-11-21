export interface InvoiceApiResponse {
  invoice: {
    slug: string;
    tradeType: 'COMMERCE' | 'P2P_CRYPTO';
    items: Array<{ name: string; quantity: number; unitPrice: number }>;
    amountNgn?: number;
    amountUsdc?: number;
    exchangeRate?: number;
    currency: 'NGN' | 'USDC';
    isEscrow: boolean;
    status: 'PENDING' | 'FUNDED_IN_ESCROW' | 'DISPATCHED' | 'RELEASED' | 'DISPUTED' | 'REFUNDED' | 'CANCELLED';
    paymentRail: 'PAYSTACK' | 'SOLANA_PDA';
    buyerWalletAddress?: string;
  };
  escrow: {
    rail: 'FIAT_PSP' | 'SOLANA_PDA';
    escrowSeed: number;
    onChainPdaAddress?: string;
    onChainVaultAddress?: string;
    dispatchProof: { aiVerified: boolean; aiSummary: string; uploadedAt: string } | null;
    autoReleaseAt?: string;
    fiatMarkedPaidAt?: string;
    disputeReason?: string;
    releasedAt?: string;
  } | null;
  vendor: {
    businessName: string;
    solanaWalletAddress?: string | null;
  };
  solana: {
    rpcUrl: string;
    programId: string | null;
    usdcMint: string | null;
    platformFeeWallet: string | null;
  };
}

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function fetchInvoice(slug: string): Promise<InvoiceApiResponse> {
  const res = await fetch(`${API}/api/invoices/${slug}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`invoice not found (${res.status})`);
  return res.json();
}

export async function postJson<T = { ok: boolean }>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `request failed (${res.status})`);
  return json;
}

export function fmtNgn(kobo?: number): string {
  if (kobo == null) return '—';
  return `₦${(kobo / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

export function fmtUsdc(base?: number): string {
  if (base == null) return '—';
  return `${(base / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC`;
}
