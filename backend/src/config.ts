import 'dotenv/config';

function bool(v: string | undefined): boolean {
  return v === 'true' || v === '1';
}

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 4000),
  publicBaseUrl: env.PUBLIC_BASE_URL ?? 'http://localhost:4000',
  useStageMocks: bool(env.USE_STAGE_MOCKS),

  whatsapp: {
    token: env.WHATSAPP_TOKEN ?? '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? '',
    verifyToken: env.WHATSAPP_VERIFY_TOKEN ?? 'kolo-verify',
    graphVersion: 'v21.0',
  },

  openai: {
    apiKey: env.OPENAI_API_KEY ?? '',
    model: env.OPENAI_MODEL ?? 'gpt-4o',
    visionModel: env.OPENAI_VISION_MODEL ?? 'gpt-4o',
  },

  paystack: {
    secretKey: env.PAYSTACK_SECRET_KEY ?? '',
    publicKey: env.PAYSTACK_PUBLIC_KEY ?? '',
  },

  mongoUri: env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/kolo',

  solana: {
    rpcUrl: env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',
    // Empty until the anchor program is deployed (prep step).
    programId: env.ESCROW_PROGRAM_ID ?? '',
    usdcMint: env.USDC_MINT ?? '',
    platformFeeWallet: env.PLATFORM_FEE_WALLET ?? '',
  },

  fees: {
    // 1.5% escrow fee, in basis points
    escrowFeeBps: 150,
  },
};

const required: Array<[string, string]> = [
  ['WHATSAPP_TOKEN', config.whatsapp.token],
  ['WHATSAPP_PHONE_NUMBER_ID', config.whatsapp.phoneNumberId],
  ['OPENAI_API_KEY', config.openai.apiKey],
  ['PAYSTACK_SECRET_KEY', config.paystack.secretKey],
  ['MONGODB_URI', config.mongoUri],
];

export function warnMissingConfig(): void {
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    console.warn(`[config] missing env vars: ${missing.join(', ')} — some flows will fail until set`);
  }
  if (!config.solana.programId) {
    console.warn('[config] ESCROW_PROGRAM_ID not set — USDC/P2P flows disabled until anchor deploy (see anchor/README.md)');
  }
  if (config.useStageMocks) {
    console.warn('[config] USE_STAGE_MOCKS=true — WhatsApp sends and payouts are simulated');
  }
}
