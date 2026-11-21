/**
 * Local smoke test of the deterministic escrow engine (no WhatsApp/OpenAI needed):
 * invoice -> mock fiat fund -> dispatch verify stub -> buyer release -> ledger.
 * Requires: local mongod running. USE_STAGE_MOCKS recommended.
 * Run: npx tsx src/scripts/smoke.ts
 */
import mongoose from 'mongoose';
import { config } from '../config';
import { connectDb } from '../db';
import { InvoiceModel, LedgerEntryModel } from '../models';
import { createCommerceInvoice } from '../services/agent';
import { mockFund, executeFiatRelease } from '../services/escrowFlow';
import { summarize } from '../services/ledger';

async function main(): Promise<void> {
  await connectDb();
  const vendorPhone = '2348000000000';
  const buyerPhone = '2348011111111';

  // 1. create invoice (same function the LLM tool calls)
  const inv = await createCommerceInvoice(vendorPhone, {
    items: [
      { name: 'Airpods Pro', quantity: 2, unitPrice: 30000 },
      { name: 'Phone case', quantity: 1, unitPrice: 3500 },
    ],
    currency: 'NGN',
    isEscrow: true,
    buyerPhone,
  });
  if (!inv.ok || !inv.payLink) throw new Error(`invoice failed: ${inv.error}`);
  const slug = inv.slug!;
  console.log(`1. invoice ${slug} created: ${(inv.amountNgn! / 100).toLocaleString()} NGN -> ${inv.payLink}`);
  if (!inv.payLink.includes('k=') || !inv.escrow) throw new Error('expected escrow invoice with buyer token link');

  // 2. mock payment webhook
  await mockFund(slug);
  let doc = await InvoiceModel.findOne({ slug });
  console.log(`2. after fund: status=${doc!.status}`);
  if (doc!.status !== 'FUNDED_IN_ESCROW') throw new Error('expected FUNDED_IN_ESCROW');

  // 3. buyer releases with the capability token from the link
  const token = new URL(inv.payLink).searchParams.get('k')!;
  const wrong = await executeFiatRelease(slug, 'wrong-token').catch((e) => e);
  if (!(wrong instanceof Error)) throw new Error('release with wrong token must fail');
  console.log(`3a. wrong token correctly rejected: ${wrong.message}`);
  await executeFiatRelease(slug, token);
  doc = await InvoiceModel.findOne({ slug });
  console.log(`3b. after release: status=${doc!.status}`);
  if (doc!.status !== 'RELEASED') throw new Error('expected RELEASED');

  // 4. ledger
  const vendorId = doc!.vendorId;
  const entries = await LedgerEntryModel.find({ invoiceId: doc!._id });
  console.log(`4. ledger entries: ${entries.map((e) => `${e.type}:${e.grossAmount}`).join(', ')}`);
  if (!entries.some((e) => e.type === 'ESCROW_HOLD') || !entries.some((e) => e.type === 'CREDIT')) {
    throw new Error('missing ledger entries');
  }
  const summary = await summarize(vendorId, 'ALL_TIME');
  console.log(`5. summary: ${JSON.stringify(summary)}`);

  const gross = inv.amountNgn!;
  const expectedFee = Math.floor((gross * config.fees.escrowFeeBps) / 10_000);
  const credit = entries.find((e) => e.type === 'CREDIT')!;
  if (credit.netAmount !== gross - expectedFee) throw new Error(`fee math wrong: net=${credit.netAmount}`);

  console.log('\nALL SMOKE TESTS PASSED ✅');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('SMOKE FAILED ❌', err);
  process.exit(1);
});
