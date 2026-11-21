import OpenAI from 'openai';
import { z } from 'zod';
import crypto from 'node:crypto';
import { config } from '../config';
import { InvoiceModel, EscrowModel, VendorModel, type IInvoice } from '../models';
import { summarize, type Timeframe } from './ledger';
import { nanoid } from 'nanoid';
import { deriveEscrowPda, deriveVaultPda, solanaConfigured } from './solana';

/**
 * TIER 1 — AI Perception. Non-deterministic on purpose, and therefore never
 * allowed to touch money: it can only emit typed tool calls, which the
 * deterministic engine validates and executes (see engine/state.ts).
 */

const client = new OpenAI({ apiKey: config.openai.apiKey });

// ─── Tool parameter schemas (Zod) ────────────────────────────────────────────

const createInvoiceSchema = z.object({
  items: z
    .array(
      z.object({
        name: z.string().min(1),
        quantity: z.number().int().positive(),
        unitPrice: z.number().positive(), // MAJOR units: naira or whole USDC
      }),
    )
    .min(1),
  currency: z.enum(['NGN', 'USDC']),
  isEscrow: z.boolean().default(true),
  buyerPhone: z.string().optional(),
});

const createP2PSchema = z.object({
  usdcAmount: z.number().positive(), // whole USDC
  nairaAmount: z.number().positive(), // whole naira the buyer will pay
  buyerPhone: z.string().optional(),
});

const ledgerSummarySchema = z.object({
  timeframe: z.enum(['TODAY', 'THIS_WEEK', 'THIS_MONTH', 'ALL_TIME']).default('THIS_WEEK'),
});

// ─── OpenAI function definitions ─────────────────────────────────────────────

const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'create_invoice',
      description:
        'Create a payment/escrow invoice for a social-commerce sale. Use when the user wants to bill a customer, sell something, charge someone, or collect payment. Returns a checkout link to forward to the buyer.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                quantity: { type: 'number' },
                unitPrice: { type: 'number', description: 'unit price in MAJOR units (naira, or whole USDC)' },
              },
              required: ['name', 'quantity', 'unitPrice'],
            },
          },
          currency: { type: 'string', enum: ['NGN', 'USDC'] },
          isEscrow: { type: 'boolean', description: 'true = buyer protection (funds held until delivery confirmed). Default true.' },
          buyerPhone: { type: 'string', description: "buyer's phone in E.164 if the user mentioned who is paying, e.g. 2348012345678" },
        },
        required: ['items', 'currency'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_p2p_escrow',
      description:
        'Create a P2P crypto-to-naira escrow: the seller locks USDC on-chain, buyer pays naira by bank transfer, seller releases the USDC. Use when the user wants to SELL crypto/USDC for naira with protection.',
      parameters: {
        type: 'object',
        properties: {
          usdcAmount: { type: 'number', description: 'whole USDC to lock and sell' },
          nairaAmount: { type: 'number', description: 'total naira the buyer pays' },
          buyerPhone: { type: 'string' },
        },
        required: ['usdcAmount', 'nairaAmount'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ledger_summary',
      description:
        "Get the vendor's earnings summary across currencies: settled vs held in escrow. Use for questions like 'how much have I made', 'my money this week', 'sales breakdown'.",
      parameters: {
        type: 'object',
        properties: {
          timeframe: { type: 'string', enum: ['TODAY', 'THIS_WEEK', 'THIS_MONTH', 'ALL_TIME'] },
        },
      },
    },
  },
];

// ─── System prompt ───────────────────────────────────────────────────────────

function systemPrompt(phone: string, businessName: string): string {
  return `You are Kolo, a friendly WhatsApp money assistant for Nigerian social-commerce vendors. Today is ${new Date().toDateString()}.

You are chatting with ${businessName} (phone ${phone}) on WhatsApp. Reply in the SAME language/style the user writes in — Nigerian Pidgin is welcome and common. Keep replies SHORT (WhatsApp style, a few lines), warm, and concrete. Light emoji use is fine.

MONEY PARSING RULES (important):
- "45k" = 45000 naira, "1.5m" = 1500000 naira, "80 bucks"/"$80" depends on context — if the user says USDC/dollar/crypto, treat as USDC; otherwise NGN.
- Convert prices to plain numbers in major units (naira or whole USDC) before calling tools. Never pass "45k" as a number string.
- If the total is ambiguous, ask ONE short clarifying question.

TOOL USAGE:
- Selling/billing/collecting payment for goods -> create_invoice (isEscrow true unless the user insists on direct payment).
- Selling USDC/crypto for naira with protection -> create_p2p_escrow.
- Money/sales/earnings questions -> ledger_summary.
- When a tool returns a link, include the EXACT link in your reply and tell the vendor to forward it to the buyer.
- If the user sends a photo of a package/waybill, that image is handled elsewhere — you only handle text.

If nothing matches, briefly explain what you can do (invoice, escrow, crypto-for-naira, sales summary). Never invent links, amounts, or order statuses.`;
}

// ─── Tool executors (deterministic side) ─────────────────────────────────────

export async function upsertVendor(phone: string, businessNameHint?: string) {
  const existing = await VendorModel.findOne({ whatsappNumber: phone });
  if (existing) return existing;
  return VendorModel.create({
    whatsappNumber: phone,
    businessName: businessNameHint?.trim() || `Vendor ${phone.slice(-4)}`,
  });
}

export interface CreateInvoiceResult {
  ok: boolean;
  slug?: string;
  payLink?: string;
  amountNgn?: number;
  amountUsdc?: number;
  currency?: string;
  escrow: boolean;
  rail?: string;
  error?: string;
}

export async function createCommerceInvoice(phone: string, argsRaw: unknown): Promise<CreateInvoiceResult> {
  const parsed = createInvoiceSchema.safeParse(argsRaw);
  if (!parsed.success) return { ok: false, escrow: true, error: `invalid invoice params: ${parsed.error.message}` };
  const args = parsed.data;

  if (args.currency === 'USDC' && !solanaConfigured()) {
    return { ok: false, escrow: args.isEscrow, error: 'USDC payments are not configured yet (Solana program not deployed). Ask for naira.' };
  }

  const vendor = await upsertVendor(phone);
  const total = args.items.reduce((sum, it) => sum + it.quantity * it.unitPrice, 0);

  const invoice = await InvoiceModel.create({
    slug: nanoid(10),
    vendorId: vendor._id,
    tradeType: 'COMMERCE',
    buyerPhone: args.buyerPhone,
    items: args.items,
    amountNgn: args.currency === 'NGN' ? Math.round(total * 100) : undefined, // kobo
    amountUsdc: args.currency === 'USDC' ? Math.round(total * 1_000_000) : undefined, // base units
    currency: args.currency,
    isEscrow: args.isEscrow,
    status: 'PENDING',
    paymentRail: args.currency === 'USDC' ? 'SOLANA_PDA' : 'PAYSTACK',
  });

  const releaseToken = crypto.randomBytes(24).toString('hex');
  // unique-ish u64 seed for the on-chain PDA (timestamp + random, < 1e9)
  const seed = (Date.now() * 1000 + Math.floor(Math.random() * 999)) % 1_000_000_000;
  await EscrowModel.create({
    invoiceId: invoice._id,
    rail: args.currency === 'USDC' ? 'SOLANA_PDA' : 'FIAT_PSP',
    escrowSeed: seed,
    ...(args.currency === 'USDC' && solanaConfigured()
      ? {
          onChainPdaAddress: deriveEscrowPda(seed).toBase58(),
          onChainVaultAddress: deriveVaultPda(deriveEscrowPda(seed)).toBase58(),
        }
      : {}),
    releaseTokenHash: crypto.createHash('sha256').update(releaseToken).digest('hex'),
  });

  // The buyer's capability link carries the release token (?k=). Fiat only;
  // USDC release is signed by the buyer's wallet on-chain instead.
  const payLink =
    args.currency === 'NGN'
      ? `${config.publicBaseUrl}/pay/${invoice.slug}?k=${releaseToken}`
      : `${config.publicBaseUrl}/pay/${invoice.slug}`;

  return {
    ok: true,
    slug: invoice.slug,
    payLink,
    amountNgn: invoice.amountNgn,
    amountUsdc: invoice.amountUsdc,
    currency: args.currency,
    escrow: args.isEscrow,
    rail: invoice.paymentRail,
  };
}

export async function createP2PEscrow(phone: string, argsRaw: unknown): Promise<{ ok: boolean; error?: string; lockLink?: string; rate?: number }> {
  if (!solanaConfigured()) return { ok: false, error: 'Solana escrow program not deployed yet (prep step). See anchor/README.md.' };
  const parsed = createP2PSchema.safeParse(argsRaw);
  if (!parsed.success) return { ok: false, error: `invalid p2p params: ${parsed.error.message}` };
  const args = parsed.data;

  const vendor = await upsertVendor(phone);
  const rate = Math.round((args.nairaAmount / args.usdcAmount) * 100) / 100;
  const invoice = await InvoiceModel.create({
    slug: nanoid(10),
    vendorId: vendor._id,
    tradeType: 'P2P_CRYPTO',
    buyerPhone: args.buyerPhone,
    amountUsdc: Math.round(args.usdcAmount * 1_000_000),
    amountNgn: Math.round(args.nairaAmount * 100),
    exchangeRate: rate,
    currency: 'USDC',
    isEscrow: true,
    status: 'PENDING',
    paymentRail: 'SOLANA_PDA',
  });

  const seed = (Date.now() * 1000 + Math.floor(Math.random() * 999)) % 1_000_000_000;
  await EscrowModel.create({
    invoiceId: invoice._id,
    rail: 'SOLANA_PDA',
    escrowSeed: seed,
    onChainPdaAddress: deriveEscrowPda(seed).toBase58(),
    onChainVaultAddress: deriveVaultPda(deriveEscrowPda(seed)).toBase58(),
    releaseTokenHash: crypto.createHash('sha256').update(crypto.randomBytes(24)).digest('hex'), // unused for P2P (wallet-signed)
  });

  return { ok: true, lockLink: `${config.publicBaseUrl}/pay/${invoice.slug}`, rate };
}

async function ledgerSummaryTool(phone: string, argsRaw: unknown): Promise<unknown> {
  const parsed = ledgerSummarySchema.safeParse(argsRaw ?? {});
  const timeframe: Timeframe = parsed.success ? parsed.data.timeframe : 'THIS_WEEK';
  const vendor = await VendorModel.findOne({ whatsappNumber: phone });
  if (!vendor) return { currencies: [], note: 'no sales recorded yet' };
  const summaries = await summarize(vendor._id, timeframe);
  return {
    timeframe,
    // amounts in smallest units — the LLM is told to format for humans
    currencies: summaries.map((s) => ({ ...s, unit: s.currency === 'NGN' ? 'kobo' : 'usdc-base-units' })),
  };
}

// ─── Vision (dispatch proof verification) ────────────────────────────────────

export interface VisionVerdict {
  aiVerified: boolean;
  confidence: number;
  aiSummary: string;
}

export async function verifyDispatchVision(image: { buffer: Buffer; mime: string }, invoice: IInvoice): Promise<VisionVerdict> {
  const itemList = invoice.items.map((i) => `${i.quantity}x ${i.name}`).join('; ');
  const dataUrl = `data:${image.mime};base64,${image.buffer.toString('base64')}`;

  const res = await client.chat.completions.create({
    model: config.openai.visionModel,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `You are auditing a vendor's pre-shipment proof for an escrow order. The invoice line items are: ${itemList}. Look at this photo (a package, product, or courier waybill). Does the photo plausibly show the item(s) ready for dispatch, or a valid dispatch waybill? Respond as JSON: {"verified": boolean, "confidence": number between 0 and 1, "summary": "one short sentence describing what you see"}. Be lenient on photo quality, strict on obvious mismatches (e.g. invoice says sneakers, photo shows a phone).`,
          },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  });

  try {
    const raw = JSON.parse(res.choices[0].message?.content ?? '{}') as { verified?: boolean; confidence?: number; summary?: string };
    return {
      aiVerified: Boolean(raw.verified),
      confidence: Number(raw.confidence ?? 0),
      aiSummary: String(raw.summary ?? 'no summary'),
    };
  } catch {
    return { aiVerified: false, confidence: 0, aiSummary: 'vision result could not be parsed' };
  }
}

// ─── Main entrypoints ────────────────────────────────────────────────────────

export async function transcribeVoice(buffer: Buffer, mime: string): Promise<string> {
  const file = new File([buffer], 'voice.ogg', { type: mime || 'audio/ogg' });
  const res = await client.audio.transcriptions.create({ model: 'whisper-1', file });
  return res.text;
}

export async function handleText(phone: string, profileName: string, text: string): Promise<string> {
  const vendor = await upsertVendor(phone, profileName);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt(phone, vendor.businessName) },
    { role: 'user', content: text },
  ];

  for (let hop = 0; hop < 3; hop++) {
    const res = await client.chat.completions.create({ model: config.openai.model, messages, tools });
    const msg = res.choices[0].message;

    if (msg.tool_calls && msg.tool_calls.length > 0) {
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        if (tc.type !== 'function') continue;
        let result: unknown;
        try {
          const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
          switch (tc.function.name) {
            case 'create_invoice':
              result = await createCommerceInvoice(phone, args);
              break;
            case 'create_p2p_escrow':
              result = await createP2PEscrow(phone, args);
              break;
            case 'ledger_summary':
              result = await ledgerSummaryTool(phone, args);
              break;
            default:
              result = { ok: false, error: `unknown tool ${tc.function.name}` };
          }
        } catch (err) {
          result = { ok: false, error: (err as Error).message };
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue; // let the model phrase the final reply with tool results
    }

    return msg.content?.trim() || 'Ok 👍';
  }
  return 'Sorry, I could not complete that. Please try again.';
}
