/**
 * Database seed — run with `npm run seed` (tsx src/seed.ts).
 *
 * Creates:
 *  • The 4 demo tenants (mirrors hrms-web/src/lib/tenants.ts SPECS), including
 *    the intentionally EMPTY 'ASM Tech Division Sdn Bhd' (co-asm-division).
 *  • The fixed user accounts (bcrypt-hashed) — mirrors the web app's
 *    FIXED_ACCOUNTS (hrms-web/src/lib/auth.ts):
 *      superadmin/super123 (SuperAdmin, cross-tenant)
 *      admin/admin123, hr/hr123 (co-asm)
 *      ahmad.faizal/manager123, tan.weiling/manager123 (co-asm, linked emp-01/emp-03)
 *      admin2/admin123, hr2/hr123 (co-merdeka)
 *      admin3/admin123, hr3/hr123 (co-desa)
 *      smithang/123123 (co-asm-division — real tenant, empty by design)
 *
 * Idempotent: ON CONFLICT updates company profiles and leaves existing
 * password hashes untouched (so changed passwords survive a re-seed).
 * Operational demo data (30 employees etc.) is NOT seeded here — import it
 * with `npm run migrate` from a browser export, or let staff enter it live.
 */
import bcrypt from 'bcryptjs';
import { pool } from './db/pool';

interface CompanySeed {
  id: string;
  code: string;
  name: string;
  regNo: string;
  hqState: string;
  plan: 'free' | 'pro' | 'enterprise';
  status: 'active' | 'suspended' | 'trial';
  accentColor: string;
  payrollCutoffDay: number;
  workingWeek: 'sat-sun' | 'fri-sat';
  leaveTopUps?: Record<string, number>;
}

const ALL_MODULES = [
  'attendance', 'leave', 'claims', 'payroll', 'kpi', 'insights', 'reports',
  'onboarding', 'offboarding',
];

const COMPANIES: CompanySeed[] = [
  {
    id: 'co-asm', code: 'ASM', name: 'ASM Tech Sdn Bhd',
    regNo: '201501023456 (1144228-K)', hqState: 'KUL', plan: 'enterprise', status: 'active',
    accentColor: '#b45309', payrollCutoffDay: 25, workingWeek: 'sat-sun',
    leaveTopUps: { annual: 2 },
  },
  {
    id: 'co-merdeka', code: 'MRD', name: 'Merdeka Manufacturing Sdn Bhd',
    regNo: '201108004321 (932211-A)', hqState: 'JHR', plan: 'pro', status: 'active',
    accentColor: '#4d7c0f', payrollCutoffDay: 26, workingWeek: 'fri-sat',
  },
  {
    id: 'co-desa', code: 'DESA', name: 'Desa Retail Group',
    regNo: '201901007654 (1317765-V)', hqState: 'PNG', plan: 'free', status: 'trial',
    accentColor: '#0f766e', payrollCutoffDay: 25, workingWeek: 'sat-sun',
  },
  {
    // Real tenant — intentionally EMPTY (no demo data).
    id: 'co-asm-division', code: 'ASMD', name: 'ASM Tech Division Sdn Bhd',
    regNo: '(registration pending)', hqState: 'KUL', plan: 'enterprise', status: 'active',
    accentColor: '#9a3412', payrollCutoffDay: 25, workingWeek: 'sat-sun',
  },
];

interface UserSeed {
  id: string;
  username: string;
  password: string;
  role: 'Admin' | 'HR' | 'Manager' | 'Employee' | 'SuperAdmin';
  companyId: string | null;
  employeeId?: string;
}

const USERS: UserSeed[] = [
  { id: 'user-superadmin', username: 'superadmin', password: 'super123', role: 'SuperAdmin', companyId: null },
  { id: 'user-admin', username: 'admin', password: 'admin123', role: 'Admin', companyId: 'co-asm' },
  { id: 'user-hr', username: 'hr', password: 'hr123', role: 'HR', companyId: 'co-asm' },
  { id: 'user-mgr-eng', username: 'ahmad.faizal', password: 'manager123', role: 'Manager', companyId: 'co-asm', employeeId: 'emp-01' },
  { id: 'user-mgr-fin', username: 'tan.weiling', password: 'manager123', role: 'Manager', companyId: 'co-asm', employeeId: 'emp-03' },
  { id: 'user-admin-mrd', username: 'admin2', password: 'admin123', role: 'Admin', companyId: 'co-merdeka' },
  { id: 'user-hr-mrd', username: 'hr2', password: 'hr123', role: 'HR', companyId: 'co-merdeka' },
  { id: 'user-admin-desa', username: 'admin3', password: 'admin123', role: 'Admin', companyId: 'co-desa' },
  { id: 'user-hr-desa', username: 'hr3', password: 'hr123', role: 'HR', companyId: 'co-desa' },
  { id: 'user-admin-asmd', username: 'smithang', password: '123123', role: 'Admin', companyId: 'co-asm-division' },
];

async function seed(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const c of COMPANIES) {
      const branding = { logoText: c.code, accentColor: c.accentColor };
      const config = {
        workingWeek: c.workingWeek,
        payrollCutoffDay: c.payrollCutoffDay,
        claimPolicy: {},
        leaveTopUps: c.leaveTopUps ?? {},
        enabledModules: ALL_MODULES,
        customFields: [],
        numberFormats: { employeeIdPrefix: c.code, payslipPrefix: `${c.code}-PS` },
        orgChart: { showDottedLineReports: false },
      };
      await client.query(
        `INSERT INTO companies (id, code, name, reg_no, hq_state, status, plan, branding, config, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'2025-01-01T00:00:00Z')
         ON CONFLICT (id) DO UPDATE SET
           code = EXCLUDED.code, name = EXCLUDED.name, reg_no = EXCLUDED.reg_no,
           hq_state = EXCLUDED.hq_state, status = EXCLUDED.status, plan = EXCLUDED.plan,
           branding = EXCLUDED.branding, config = EXCLUDED.config, updated_at = now()`,
        [c.id, c.code, c.name, c.regNo, c.hqState, c.status, c.plan,
         JSON.stringify(branding), JSON.stringify(config)],
      );
      console.log(`company  ${c.id.padEnd(18)} ${c.name}`);
    }

    for (const u of USERS) {
      const hash = bcrypt.hashSync(u.password, 10);
      // Insert-only for the hash: re-seeding never resets a changed password.
      await client.query(
        `INSERT INTO users (id, username, password_hash, role, company_id, employee_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET
           username = EXCLUDED.username, role = EXCLUDED.role,
           company_id = EXCLUDED.company_id, employee_id = EXCLUDED.employee_id,
           updated_at = now()`,
        [u.id, u.username, hash, u.role, u.companyId, u.employeeId ?? null],
      );
      console.log(`user     ${u.username.padEnd(18)} ${u.role.padEnd(11)} ${u.companyId ?? '(system)'}`);
    }

    await client.query('COMMIT');
    console.log('\nSeed complete. ASM Tech Division Sdn Bhd (co-asm-division) is intentionally EMPTY.');
    console.log('Import browser demo data with: npm run migrate -- --file <export.json> --company co-asm');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
