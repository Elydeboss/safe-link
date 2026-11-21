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

  ai: {
    apiKey: env.AI_API_KEY ?? env.OPENAI_API_KEY ?? '',
    // 'gemini' | 'groq' | 'openai' | 'openrouter' — all OpenAI-compatible endpoints
    provider: (env.AI_PROVIDER ?? (env.AI_API_KEY ? 'gemini' : 'openai')) as 'gemini' | 'groq' | 'openai' | 'openrouter',
    baseUrl: env.AI_BASE_URL ?? '',
    chatModel: env.AI_CHAT_MODEL ?? '',
    visionModel: env.AI_VISION_MODEL ?? '',
    audioModel: env.AI_AUDIO_MODEL ?? '',
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

/** Model defaults per provider. Override with AI_CHAT_MODEL / AI_VISION_MODEL / AI_AUDIO_MODEL. */
export function aiModels(): { chat: string; vision: string; audio: string } {
  const c = config.ai;
  switch (c.provider) {
    case 'gemini':
      return {
        chat: c.chatModel || 'gemini-2.5-flash',
        vision: c.visionModel || c.chatModel || 'gemini-2.5-flash',
        audio: c.audioModel || 'gemini-2.5-flash',
      };
    case 'groq':
      return {
        chat: c.chatModel || 'llama-3.3-70b-versatile',
        vision: c.visionModel || 'meta-llama/llama-4-scout-17b-16e-instruct',
        audio: c.audioModel || 'whisper-large-v3',
      };
    default:
      return {
        chat: c.chatModel || 'gpt-4o',
        vision: c.visionModel || c.chatModel || 'gpt-4o',
        audio: c.audioModel || 'whisper-1',
      };
  }
}

export function providerBaseUrl(provider: string): string | undefined {
  switch (provider) {
    case 'gemini':
      return 'https://generativelanguage.googleapis.com/v1beta/openai/';
    case 'groq':
      return 'https://api.groq.com/openai/v1';
    case 'openrouter':
      return 'https://openrouter.ai/api/v1';
    default:
      return undefined; // official OpenAI
  }
}

const required: Array<[string, string]> = [
  ['WHATSAPP_TOKEN', config.whatsapp.token],
  ['WHATSAPP_PHONE_NUMBER_ID', config.whatsapp.phoneNumberId],
  ['AI_API_KEY (or OPENAI_API_KEY)', config.ai.apiKey],
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
