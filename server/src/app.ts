/** Fastify app assembly — kept separate from index.ts for testability. */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config, assertProductionConfig } from './config';
import { pingDb } from './db/pool';
import authGuard from './auth/guard';
import authRoutes from './routes/auth';
import companyRoutes from './routes/companies';
import collectionRoutes from './routes/collections';
import payrollRoutes from './routes/payroll';
import auditRoutes from './routes/audit';

export async function buildApp() {
  const app = Fastify({
    logger: true,
    // Payroll payloads (whole-month payslips) can be sizeable.
    bodyLimit: 10 * 1024 * 1024,
  });

  assertProductionConfig(app.log);

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
  });
  await app.register(rateLimit, {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindow,
  });
  await app.register(authGuard);

  app.get('/health', async () => ({ ok: true, db: await pingDb(), at: new Date().toISOString() }));

  await app.register(authRoutes);
  await app.register(companyRoutes);
  await app.register(payrollRoutes);
  await app.register(auditRoutes);
  await app.register(collectionRoutes); // param routes last

  return app;
}
