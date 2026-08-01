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

export const config = {
  port: int(process.env.PORT, 4010),
  host: process.env.HOST ?? '0.0.0.0',

  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://hrms:hrms@localhost:5432/hrms',
  pgSsl: bool(process.env.PGSSL, false),
  pgSslRejectUnauthorized: bool(process.env.PGSSL_REJECT_UNAUTHORIZED, true),

  /** REQUIRED in production — set via env, never commit. */
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-secret-change-me',
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

/** Warn loudly when obviously-insecure dev defaults reach production. */
export function assertProductionConfig(log: { warn: (msg: string) => void }): void {
  if (config.jwtSecret === 'dev-only-secret-change-me') {
    log.warn('JWT_SECRET is the built-in dev default — set a strong secret before exposing this service.');
  }
}
