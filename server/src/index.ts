/** Server entrypoint. */
import { buildApp } from './app';
import { config } from './config';

async function main(): Promise<void> {
  const app = await buildApp();
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received — shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// Boot failures (e.g. assertProductionConfig refusing an insecure production
// secret) land here — log and exit non-zero instead of an unhandled rejection.
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
