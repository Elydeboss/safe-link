import { LedgerEntryModel, type ILedgerEntry, type LedgerType } from '../models/ledgerEntry';
import type { IInvoice } from '../models/invoice';

/** Double-entry-ish ledger writes. Integer smallest units only (kobo / USDC base). */

export async function recordEntry(input: {
  vendorId: ILedgerEntry['vendorId'];
  invoiceId: ILedgerEntry['invoiceId'];
  type: LedgerType;
  currency: IInvoice['currency'];
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
}): Promise<void> {
  await LedgerEntryModel.create(input);
}

export type Timeframe = 'TODAY' | 'THIS_WEEK' | 'THIS_MONTH' | 'ALL_TIME';

export interface CurrencySummary {
  currency: string;
  settledGross: number;
  escrowHeld: number;
  fees: number;
  settledNet: number;
  releasedCount: number;
  heldCount: number;
}

export async function summarize(vendorId: ILedgerEntry['vendorId'], timeframe: Timeframe): Promise<CurrencySummary[]> {
  const since = startOf(timeframe);
  const entries = await LedgerEntryModel.find({ vendorId, ...(since ? { createdAt: { $gte: since } } : {}) });

  const byCurrency = new Map<string, CurrencySummary>();
  const bucket = (currency: string): CurrencySummary => {
    let b = byCurrency.get(currency);
    if (!b) {
      b = { currency, settledGross: 0, escrowHeld: 0, fees: 0, settledNet: 0, releasedCount: 0, heldCount: 0 };
      byCurrency.set(currency, b);
    }
    return b;
  };

  for (const e of entries) {
    const b = bucket(e.currency);
    if (e.type === 'CREDIT') {
      b.settledGross += e.grossAmount;
      b.settledNet += e.netAmount;
      b.releasedCount += 1;
    } else if (e.type === 'ESCROW_HOLD') {
      b.escrowHeld += e.grossAmount;
      b.heldCount += 1;
    } else if (e.type === 'FEE') {
      b.fees += e.feeAmount;
    }
  }
  return [...byCurrency.values()];
}

function startOf(timeframe: Timeframe): Date | null {
  const now = new Date();
  switch (timeframe) {
    case 'TODAY':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    case 'THIS_WEEK': {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      d.setDate(d.getDate() - d.getDay()); // Sunday start
      return d;
    }
    case 'THIS_MONTH':
      return new Date(now.getFullYear(), now.getMonth(), 1);
    default:
      return null;
  }
}
