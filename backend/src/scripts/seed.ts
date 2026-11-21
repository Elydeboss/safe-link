/**
 * Seeds/updates the demo vendor so fiat payouts have somewhere to go.
 * Run: npm run seed
 */
import { config } from '../config';
import { connectDb } from '../db';
import { VendorModel } from '../models';
import { createTransferRecipient } from '../services/paystack';
import mongoose from 'mongoose';

async function main(): Promise<void> {
  await connectDb();

  const phone = process.env.DEMO_VENDOR_PHONE ?? '';
  if (!phone) {
    console.error('set DEMO_VENDOR_PHONE in .env first');
    process.exit(1);
  }

  const bankCode = process.env.DEMO_VENDOR_BANK_CODE ?? '058';
  const accountNumber = process.env.DEMO_VENDOR_ACCOUNT_NUMBER ?? '0123456789';
  const name = process.env.DEMO_VENDOR_NAME ?? 'Demo Vendor';
  const solanaWallet = process.env.DEMO_VENDOR_SOLANA_WALLET || undefined;

  let recipientCode: string | undefined;
  if (config.paystack.secretKey && !config.useStageMocks) {
    try {
      const r = await createTransferRecipient({ name, accountNumber, bankCode });
      recipientCode = r.recipient_code;
      console.log('[seed] paystack recipient created:', recipientCode);
    } catch (err) {
      console.warn('[seed] paystack recipient failed (payouts will be mocked):', (err as Error).message);
    }
  } else {
    console.log('[seed] skipping paystack recipient (no key or mocks on) — payouts will be mocked');
  }

  const vendor = await VendorModel.findOneAndUpdate(
    { whatsappNumber: phone },
    {
      $set: {
        businessName: name,
        'payoutDetails.ngnBankCode': bankCode,
        'payoutDetails.ngnAccountNumber': accountNumber,
        'payoutDetails.ngnAccountName': name,
        ...(recipientCode ? { 'payoutDetails.paystackRecipientCode': recipientCode } : {}),
        ...(solanaWallet ? { 'payoutDetails.solanaWalletAddress': solanaWallet } : {}),
      },
    },
    { upsert: true, new: true },
  );

  console.log('[seed] vendor ready:', JSON.stringify({ phone, name, recipient: recipientCode ?? 'MOCK', solanaWallet: vendor.payoutDetails.solanaWalletAddress ?? 'none' }, null, 2));
  await mongoose.disconnect();
}

void main();
