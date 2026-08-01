/**
 * migrate-from-browser — imports the web app's localStorage JSON export
 * (Settings → Data management → "Export all data (JSON)") into Postgres.
 *
 * The export contains the ACTIVE tenant's collections:
 *   { app, version, exportedAt, collections, data: { <collection>: [...] } }
 * Run it once per company (switch tenant in the web app, export again):
 *
 *   npm run migrate -- --file hrms-export-2026-02-05.json --company co-asm
 *   npm run migrate -- --file merdeka.json --company co-merdeka
 *
 * Optional: import the account directory (localStorage 'hrms.users' —
 * UserAccount[] with DEMO plaintext passwords; they are bcrypt-hashed here):
 *
 *   npm run migrate -- --users-file hrms-users.json
 *
 * Notes
 * ─────
 * • The 'holidays' collection is NATIONAL — imported once as global rows.
 * • 'audit' entries land in the audit table with extracted columns.
 * • Unknown/extra collections in the file are skipped with a warning.
 * • Re-running upserts by id (idempotent).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db/pool';
import { COLLECTIONS, upsertDoc } from '../src/db/collections';
import { uid } from '../src/calc/utils';

interface Args {
  pairs: { file: string; company: string }[];
  usersFile?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { pairs: [] };
  let pendingFile: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--file') pendingFile = next();
    else if (a === '--company' && pendingFile) args.pairs.push({ file: pendingFile, company: next() ?? '' });
    else if (a === '--company') args.pairs.push({ file: '', company: next() ?? '' });
    else if (a === '--users-file') args.usersFile = next();
    else if (a?.startsWith('--file=')) pendingFile = a.slice('--file='.length);
    else if (a?.startsWith('--company=') && pendingFile) args.pairs.push({ file: pendingFile, company: a.slice('--company='.length) });
    else if (a?.startsWith('--users-file=')) args.usersFile = a.slice('--users-file='.length);
  }
  args.pairs = args.pairs.filter((p) => p.file && p.company);
  return args;
}

interface ExportFile {
  data?: Record<string, unknown[]>;
}

async function migrateFile(file: string, companyId: string): Promise<void> {
  const full = path.resolve(process.cwd(), file);
  const parsed = JSON.parse(readFileSync(full, 'utf8')) as ExportFile;
  if (!parsed.data || typeof parsed.data !== 'object') {
    throw new Error(`${file}: not a recognised HRMS export (missing "data" map).`);
  }
  const company = await pool.query('SELECT id FROM companies WHERE id = $1', [companyId]);
  if (!company.rows[0]) {
    throw new Error(`${file}: company '${companyId}' does not exist — run npm run seed first (or create it via /api/companies).`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [name, docs] of Object.entries(parsed.data)) {
      if (!Array.isArray(docs)) continue;
      if (name === 'audit') {
        for (const d of docs as Record<string, unknown>[]) {
          await client.query(
            `INSERT INTO audit (company_id, id, at, actor_id, actor_name, action, entity, entity_id, detail, data)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (id) DO NOTHING`,
            [
              companyId,
              (d.id as string) || uid(),
              (d.at as string) ?? new Date().toISOString(),
              (d.actorId as string) ?? null,
              (d.actorName as string) ?? '',
              (d.action as string) ?? '',
              (d.entity as string) ?? '',
              (d.entityId as string) ?? null,
              (d.detail as string) ?? null,
              JSON.stringify(d),
            ],
          );
        }
        console.log(`  audit: ${docs.length} entries`);
        continue;
      }
      const def = COLLECTIONS[name];
      if (!def) {
        console.warn(`  ! skipped unknown collection '${name}' (${docs.length} docs)`);
        continue;
      }
      for (const d of docs as Record<string, unknown>[]) {
        await upsertDoc(def, def.global ? null : companyId, d, client);
      }
      console.log(`  ${name}: ${docs.length} docs${def.global ? ' (global)' : ''}`);
    }
    await client.query('COMMIT');
    console.log(`✓ ${file} → company '${companyId}'`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

interface BrowserUser {
  id: string;
  username: string;
  password: string; // DEMO plaintext — hashed on import
  role: string;
  companyId: string | null;
  employeeId?: string;
}

async function migrateUsers(file: string): Promise<void> {
  const full = path.resolve(process.cwd(), file);
  const users = JSON.parse(readFileSync(full, 'utf8')) as BrowserUser[];
  if (!Array.isArray(users)) throw new Error(`${file}: expected a UserAccount[] array.`);
  let n = 0;
  for (const u of users) {
    const hash = bcrypt.hashSync(u.password, 10);
    await pool.query(
      `INSERT INTO users (id, username, password_hash, role, company_id, employee_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET
         username = EXCLUDED.username, role = EXCLUDED.role,
         company_id = EXCLUDED.company_id, employee_id = EXCLUDED.employee_id, updated_at = now()`,
      [u.id || uid(), u.username, hash, u.role, u.companyId, u.employeeId ?? null],
    );
    n += 1;
  }
  console.log(`✓ ${file}: ${n} user accounts imported (passwords bcrypt-hashed)`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.pairs.length === 0 && !args.usersFile) {
    console.error('Usage: npm run migrate -- --file <export.json> --company <companyId> [--users-file <users.json>]');
    process.exit(1);
  }
  for (const pair of args.pairs) {
    await migrateFile(pair.file, pair.company);
  }
  if (args.usersFile) await migrateUsers(args.usersFile);
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
