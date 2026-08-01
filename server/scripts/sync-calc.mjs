#!/usr/bin/env node
/**
 * sync-calc — re-copies the shared calculation modules from the web app into
 * server/src/calc/ so the API computes payroll with the SAME code as the
 * browser engine. Run after any change to hrms-web/src/lib/statutory.ts or
 * hrms-web/src/lib/workdays.ts, then `npm run typecheck`.
 *
 *   node scripts/sync-calc.mjs      (or: npm run sync-calc)
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const webLib = path.resolve(serverRoot, '..', 'hrms-web', 'src', 'lib');
const calcDir = path.join(serverRoot, 'src', 'calc');

const BANNER = `/**\n * ⚠️ SYNC COPY — DO NOT EDIT IN PLACE.\n * Source of truth: hrms-web/src/lib/%NAME%\n * Re-sync with:  cd server && npm run sync-calc\n */\n`;

function sync(name, { required }) {
  const src = path.join(webLib, name);
  const dest = path.join(calcDir, name);
  if (!existsSync(src)) {
    if (required) {
      console.error(`✗ ${src} not found (required) — aborting.`);
      process.exit(1);
    }
    console.warn(`! ${src} not found — keeping existing server copy (check its SYNC NOTE).`);
    return;
  }
  copyFileSync(src, dest);
  // Prepend the banner (replacing a previous one if present).
  const body = readFileSync(dest, 'utf8').replace(/^\/\*\*[\s\S]*?SYNC COPY[\s\S]*?\*\/\n*/, '');
  writeFileSync(dest, BANNER.replace('%NAME%', name) + body);
  console.log(`✓ ${name} → server/src/calc/${name}`);
}

sync('statutory.ts', { required: true });
// holidayData.ts is self-contained (curated public-holiday calendar, imports
// only types) — copied verbatim like statutory.ts.
sync('holidayData.ts', { required: true });
// workdays.ts is NOT copied: the web module imports lib/db + lib/holidays
// (browser-only). server/src/calc/workdays.ts + calc/holidays.ts are
// dependency-free PORTS — re-port them manually when the web modules change
// (same rule as calc/payroll.ts vs the web payrollEngine.ts).
console.log('! workdays.ts / holidays.ts are manual ports (web-only imports) — see their SYNC NOTEs.');
console.log('Done. Run `npm run typecheck` to verify.');
