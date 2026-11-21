import mongoose, { Schema, type Document } from 'mongoose';

export type EscrowRail = 'FIAT_PSP' | 'SOLANA_PDA';

export interface IDispatchProof {
  mediaUrl?: string;
  aiVerified: boolean;
  aiSummary: string;
  confidence: number;
  uploadedAt: Date;
}

export interface IEscrow extends Document {
  invoiceId: mongoose.Types.ObjectId;
  rail: EscrowRail;
  /** u64 seed used in the on-chain PDA derivation ([b"escrow", seed_le]). */
  escrowSeed: number;
  onChainPdaAddress?: string;
  onChainVaultAddress?: string;
  /** sha256 of the release capability token embedded in the buyer's link (?k=). */
  releaseTokenHash: string;
  dispatchProof?: IDispatchProof;
  autoReleaseAt?: Date;
  fiatMarkedPaidAt?: Date;
  releasedAt?: Date;
  payoutTxReference?: string;
  disputeReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const EscrowSchema = new Schema<IEscrow>(
  {
    invoiceId: { type: Schema.Types.ObjectId, ref: 'Invoice', required: true, unique: true },
    rail: { type: String, enum: ['FIAT_PSP', 'SOLANA_PDA'], required: true },
    escrowSeed: { type: Number, required: true },
    onChainPdaAddress: String,
    onChainVaultAddress: String,
    releaseTokenHash: { type: String, required: true },
    dispatchProof: {
      mediaUrl: String,
      aiVerified: { type: Boolean, default: false },
      aiSummary: String,
      confidence: { type: Number, default: 0 },
      uploadedAt: Date,
    },
    autoReleaseAt: Date,
    fiatMarkedPaidAt: Date,
    releasedAt: Date,
    payoutTxReference: String,
    disputeReason: String,
  },
  { timestamps: true },
);

export const EscrowModel = mongoose.model<IEscrow>('Escrow', EscrowSchema);
