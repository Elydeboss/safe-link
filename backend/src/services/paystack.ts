import crypto from 'node:crypto';
import { config } from '../config';

/**
 * Paystack client (TEST MODE for the hackathon).
 * Honest framing (see SPEC §2): Paystack has no escrow product. Funds settle
 * to our merchant account; we hold the invoice state and pay the vendor out
 * via the Transfers API only when the buyer releases.
 */

const BASE = 'https://api.paystack.co';

async function ps<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.paystack.secretKey}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  const json = (await res.json().catch(() => ({}))) as { status: boolean; message?: string; data?: T };
  if (!res.ok || json.status === false) {
    throw new Error(`paystack ${path} failed: ${res.status} ${json.message ?? ''}`);
  }
  return json.data as T;
}

/** HMAC-SHA512 of the RAW request body, per Paystack webhook docs. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature || !config.paystack.secretKey) return false;
  const hash = crypto.createHmac('sha512', config.paystack.secretKey).update(rawBody).digest('hex');
  const a = Buffer.from(hash);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function verifyTransaction(reference: string): Promise<{ status: string; amount: number; paidAt?: string }> {
  return ps(`/transaction/verify/${encodeURIComponent(reference)}`);
}

/** Fallback/confirmation path when the webhook was missed: checks Paystack
 *  directly before trusting a client-side success callback. */
export async function isChargeSuccessful(reference: string): Promise<boolean> {
  try {
    const v = await verifyTransaction(reference);
    return v.status === 'success';
  } catch {
    return false;
  }
}

export async function createTransferRecipient(input: {
  name: string;
  accountNumber: string;
  bankCode: string;
}): Promise<{ recipient_code: string }> {
  return ps('/transfer/recipient', {
    method: 'POST',
    body: JSON.stringify({
      type: 'nuban',
      name: input.name,
      account_number: input.accountNumber,
      bank_code: input.bankCode,
      currency: 'NGN',
    }),
  });
}

export async function initiateTransfer(input: {
  amountKobo: number;
  recipientCode: string;
  reason: string;
  reference: string;
}): Promise<{ transfer_code: string; status: string }> {
  return ps('/transfer', {
    method: 'POST',
    body: JSON.stringify({
      source: 'balance',
      amount: input.amountKobo,
      recipient: input.recipientCode,
      reason: input.reason,
      reference: input.reference,
    }),
  });
}
