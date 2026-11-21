import mongoose, { Schema, type Document } from 'mongoose';
import type { InvoiceCurrency } from './invoice';

export type LedgerType = 'CREDIT' | 'ESCROW_HOLD' | 'FEE' | 'REFUND';

export interface ILedgerEntry extends Document {
  vendorId: mongoose.Types.ObjectId;
  invoiceId: mongoose.Types.ObjectId;
  type: LedgerType;
  currency: InvoiceCurrency;
  /** All integer smallest units: kobo for NGN, base units for USDC. */
  grossAmount: number;
  feeAmount: number;
  netAmount: number;
  createdAt: Date;
}

const LedgerEntrySchema = new Schema<ILedgerEntry>(
  {
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true },
    type: { type: String, enum: ['CREDIT', 'ESCROW_HOLD', 'FEE', 'REFUND'], required: true },
    currency: { type: String, enum: ['NGN', 'USDC'], required: true },
    grossAmount: { type: Number, required: true },
    feeAmount: { type: Number, required: true },
    netAmount: { type: Number, required: true },
  },
  { timestamps: true },
);

LedgerEntrySchema.index({ createdAt: 1 });

export const LedgerEntryModel = mongoose.model<ILedgerEntry>('LedgerEntry', LedgerEntrySchema);
