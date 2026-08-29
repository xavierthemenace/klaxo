/**
 * Server-side configuration.
 *
 * Every value is validated once, at first access, with Zod. Nothing here is
 * prefixed `NEXT_PUBLIC_`, so none of it can reach the browser bundle.
 */
import { z } from 'zod';

function assertServerOnly(): void {
  if (typeof window !== 'undefined') {
    throw new Error(
      'src/lib/env.ts was imported into client code. Server credentials must never reach the browser.',
    );
  }
}

const boolFromString = (dflt: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : v.toLowerCase() === 'true'));

const intFromString = (dflt: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const floatFromString = (dflt: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? dflt : Number(v)))
    .pipe(z.number().min(min).max(max));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  FCC_SERVER_BASE_URL: z
    .string()
    .optional()
    .transform((v) =>
      v && v.trim() !== ''
        ? v.trim().replace(/\/+$/, '')
        : 'https://integrate.api.nvidia.com/v1',
    ),
  FCC_SERVER_API_KEY: optionalString,

  NVIDIA_NIM_MODEL: z
    .string()
    .optional()
    .transform((v) =>
      v && v.trim() !== '' ? v.trim() : 'nvidia/nemotron-3-super-120b-a12b',
    ),
  NVIDIA_NIM_VISION_MODEL: z
    .string()
    .optional()
    .transform((v) =>
      v && v.trim() !== '' ? v.trim() : 'meta/llama-3.2-90b-vision-instruct',
    ),
  NVIDIA_NIM_EMBEDDING_MODEL: z
    .string()
    .optional()
    .transform((v) =>
      v && v.trim() !== '' ? v.trim() : 'nvidia/nv-embedqa-mistral-7b-v2',
    ),
  NIM_MODEL_PLANNING: optionalString,
  NIM_MODEL_GENERATION: optionalString,
  NIM_MODEL_ASSESSMENT: optionalString,
  NIM_MODEL_QA: optionalString,
  NIM_ENABLE_EMBEDDINGS: boolFromString(false),

  AI_MAX_RETRIES: intFromString(3, 1, 6),
  AI_REQUEST_TIMEOUT_MS: intFromString(120_000, 5_000, 600_000),
  AI_MAX_TOKENS: intFromString(4096, 256, 32_768),
  AI_TEMPERATURE: floatFromString(0.3, 0, 2),
  AI_MIN_REQUEST_INTERVAL_MS: intFromString(2000, 0, 60_000),
  AI_MAX_CONCURRENCY: intFromString(2, 1, 32),
  AI_DEV_MODE: boolFromString(false),

  // Storage: SQLite is retained for local development and single-writer deployments.
  // A future multi-region deployment should move this repository layer to Postgres.
  DATABASE_FILE: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : './data/mastery.db')),
  DATABASE_BUSY_TIMEOUT_MS: intFromString(10_000, 1_000, 120_000),
  UPLOAD_DIR: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : './uploads')),
  MAX_UPLOAD_BYTES: intFromString(10 * 1024 * 1024, 1024, 100 * 1024 * 1024),
  MAX_UPLOAD_FILES: intFromString(10, 1, 50),

  WORKER_CONCURRENCY: intFromString(2, 1, 16),
  WORKER_POLL_MS: intFromString(1500, 250, 60_000),

  APP_SECRET: z
    .string()
    .optional()
    .transform((v) =>
      v && v.trim() !== '' ? v.trim() : 'insecure-development-secret',
    ),
  RATE_LIMIT_PER_MINUTE: intFromString(20, 1, 10_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_SOURCE_PREVIEWS: boolFromString(false),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  assertServerOnly();
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  const env = parsed.data;

  if (env.NODE_ENV === 'production') {
    if (env.APP_SECRET === 'insecure-development-secret' || env.APP_SECRET.length < 32) {
      throw new Error('APP_SECRET must be a strong 32+ character secret in production.');
    }
    if (env.AI_DEV_MODE) {
      throw new Error('AI_DEV_MODE=true is not allowed in production.');
    }
    if (!env.FCC_SERVER_API_KEY) {
      throw new Error('FCC_SERVER_API_KEY is required in production.');
    }
    if (env.DATABASE_FILE === ':memory:') {
      throw new Error('DATABASE_FILE=:memory: is not allowed in production.');
    }
  }

  cached = env;
  return cached;
}

export function resetEnvCache(): void {
  cached = null;
}

export function isRealAiEnabled(env: Env = getEnv()): boolean {
  return !env.AI_DEV_MODE && Boolean(env.FCC_SERVER_API_KEY);
}

export function publicAiStatus(env: Env = getEnv()) {
  return {
    devMode: env.AI_DEV_MODE,
    baseUrl: env.FCC_SERVER_BASE_URL,
    hasCredential: Boolean(env.FCC_SERVER_API_KEY),
    realAiEnabled: isRealAiEnabled(env),
    models: {
      text: env.NVIDIA_NIM_MODEL,
      vision: env.NVIDIA_NIM_VISION_MODEL,
      embedding: env.NVIDIA_NIM_EMBEDDING_MODEL,
      planning: env.NIM_MODEL_PLANNING ?? env.NVIDIA_NIM_MODEL,
      generation: env.NIM_MODEL_GENERATION ?? env.NVIDIA_NIM_MODEL,
      assessment: env.NIM_MODEL_ASSESSMENT ?? env.NVIDIA_NIM_MODEL,
      qa: env.NIM_MODEL_QA ?? env.NVIDIA_NIM_MODEL,
    },
    embeddingsEnabled: env.NIM_ENABLE_EMBEDDINGS,
  } as const;
}
