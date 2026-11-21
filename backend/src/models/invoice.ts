import mongoose, { Schema, type Document } from 'mongoose';

export type TradeType = 'COMMERCE' | 'P2P_CRYPTO';
export type InvoiceCurrency = 'NGN' | 'USDC';
export type InvoiceStatus =
  | 'PENDING'
  | 'FUNDED_IN_ESCROW'
  | 'DISPATCHED'
  | 'RELEASED'
  | 'DISPUTED'
  | 'REFUNDED'
  | 'CANCELLED';
export type PaymentRail = 'PAYSTACK' | 'SOLANA_PDA';

export interface IInvoice extends Document {
  slug: string;
  vendorId: mongoose.Types.ObjectId;
  tradeType: TradeType;
  buyerPhone?: string;
  buyerWalletAddress?: string;
  items: Array<{ name: string; quantity: number; unitPrice: number }>;
  /** NGN amount in kobo (integer). */
  amountNgn?: number;
  /** USDC amount in base units (integer, 6 decimals). */
  amountUsdc?: number;
  /** P2P only: NGN per 1 USDC. */
  exchangeRate?: number;
  currency: InvoiceCurrency;
  isEscrow: boolean;
  status: InvoiceStatus;
  paymentRail: PaymentRail;
  externalReference?: string;
  createdAt: Date;
  updatedAt: Date;
}

const InvoiceSchema = new Schema<IInvoice>(
  {
    slug: { type: String, required: true, unique: true, index: true },
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true },
    tradeType: { type: String, enum: ['COMMERCE', 'P2P_CRYPTO'], required: true },
    buyerPhone: String,
    buyerWalletAddress: String,
    items: [
      {
        name: { type: String, required: true },
        quantity: { type: Number, required: true, default: 1 },
        unitPrice: { type: Number, required: true },
      },
    ],
    amountNgn: Number,
    amountUsdc: Number,
    exchangeRate: Number,
    currency: { type: String, enum: ['NGN', 'USDC'], required: true },
    isEscrow: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ['PENDING', 'FUNDED_IN_ESCROW', 'DISPATCHED', 'RELEASED', 'DISPUTED', 'REFUNDED', 'CANCELLED'],
      default: 'PENDING',
      index: true,
    },
    paymentRail: { type: String, enum: ['PAYSTACK', 'SOLANA_PDA'], required: true },
    externalReference: { type: String, index: true },
  },
  { timestamps: true },
);

export const InvoiceModel = mongoose.model<IInvoice>('Invoice', InvoiceSchema);
