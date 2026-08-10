/** Centralised environment config (dotenv-loaded). */
import 'dotenv/config';

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Built-in fallback used ONLY for local development. Never production-safe. */
const DEV_JWT_SECRET = 'dev-only-secret-change-me';

export const config = {
  port: int(process.env.PORT, 4010),
  host: process.env.HOST ?? '0.0.0.0',

  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProduction: process.env.NODE_ENV === 'production',

  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://hrms:hrms@localhost:5432/hrms',
  pgSsl: bool(process.env.PGSSL, false),
  pgSslRejectUnauthorized: bool(process.env.PGSSL_REJECT_UNAUTHORIZED, true),

  /** REQUIRED in production — set via env, never commit. */
  jwtSecret: process.env.JWT_SECRET ?? DEV_JWT_SECRET,
  /** Access-token lifetime (jsonwebtoken `expiresIn`), default 12h. */
  jwtTtl: process.env.JWT_TTL ?? '12h',

  corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  rateLimitMax: int(process.env.RATE_LIMIT_MAX, 300),
  rateLimitWindow: process.env.RATE_LIMIT_WINDOW ?? '1 minute',
  loginRateLimitMax: int(process.env.LOGIN_RATE_LIMIT_MAX, 10),
} as const;

/**
 * Boot-time guard for the JWT secret.
 * - PRODUCTION (NODE_ENV=production): FAIL FAST — an unset secret or the
 *   built-in dev default aborts boot (thrown here, surfaced by index.ts).
 * - Development: warn loudly and continue so local onboarding stays easy.
 */
export function assertProductionConfig(log: { warn: (msg: string) => void }): void {
  const insecureSecret = !process.env.JWT_SECRET || config.jwtSecret === DEV_JWT_SECRET;
  if (!insecureSecret) return;
  const reason = 'JWT_SECRET is unset or set to the built-in dev default';
  if (config.isProduction) {
    throw new Error(
      `FATAL: ${reason}. Refusing to boot in production — set a strong JWT_SECRET (e.g. \`openssl rand -hex 32\`).`,
    );
  }
  log.warn(`${reason} — set a strong secret before exposing this service.`);
}
