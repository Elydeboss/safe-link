import mongoose, { Schema, type Document } from 'mongoose';

export interface IVendor extends Document {
  whatsappNumber: string;
  businessName: string;
  payoutDetails: {
    ngnBankCode?: string;
    ngnAccountNumber?: string;
    ngnAccountName?: string;
    paystackRecipientCode?: string;
    solanaWalletAddress?: string;
  };
  stats: {
    totalVolumeNgn: number;
    totalVolumeUsdc: number;
    completedEscrows: number;
    disputedEscrows: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

const VendorSchema = new Schema<IVendor>(
  {
    whatsappNumber: { type: String, required: true, unique: true, index: true },
    businessName: { type: String, required: true },
    payoutDetails: {
      ngnBankCode: String,
      ngnAccountNumber: String,
      ngnAccountName: String,
      paystackRecipientCode: String,
      solanaWalletAddress: String,
    },
    stats: {
      totalVolumeNgn: { type: Number, default: 0 },
      totalVolumeUsdc: { type: Number, default: 0 },
      completedEscrows: { type: Number, default: 0 },
      disputedEscrows: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);

export const VendorModel = mongoose.model<IVendor>('Vendor', VendorSchema);
