/**
 * Live AI agent test — exercises the REAL pipeline (no WhatsApp needed):
 * Tier 1 LLM tool-calling -> Tier 2 engine -> invoice in DB + phrased reply.
 * Run: npx tsx src/scripts/agent-test.ts
 */
import mongoose from 'mongoose';
import { connectDb } from '../db';
import { handleText } from '../services/agent';
import { InvoiceModel } from '../models';

const VENDOR = '2348000000000';
const NAME = 'Ada';

async function say(text: string): Promise<string> {
  console.log(`\n🧑🏽 VENDOR: ${text}`);
  const reply = await handleText(VENDOR, NAME, text);
  console.log(`🤖 KOLO:   ${reply}`);
  return reply;
}

async function main(): Promise<void> {
  await connectDb();

  // 1. Pidgin invoice request — expect create_invoice tool call + link in reply
  const reply = await say('Abeg create invoice for 2 Airpods Pro, 60k total, for Chioma. With escrow abeg');
  if (!reply.includes('http')) throw new Error('FAIL: expected a checkout link in the reply');

  // 2. Verify the deterministic side wrote the right numbers
  const inv = await InvoiceModel.findOne({}, {}, { sort: { createdAt: -1 } });
  console.log(`\n📦 DB: slug=${inv?.slug} amount=${inv?.amountNgn} kobo rail=${inv?.paymentRail} status=${inv?.status}`);
  if (inv?.amountNgn !== 6_000_000) throw new Error(`FAIL: expected 6000000 kobo, got ${inv?.amountNgn}`);

  // 3. Ledger query — expect ledger_summary tool call + human phrasing
  await say('How much I don make this week?');

  // 4. Ambiguous request — expect a clarifying question, not a broken tool call
  await say('sell something');

  console.log('\nAGENT TEST PASSED ✅');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('AGENT TEST FAILED ❌', err);
  process.exit(1);
});
