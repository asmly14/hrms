/**
 * Payroll lifecycle endpoints — Admin/HR (+SuperAdmin with explicit scope).
 * Calculation lives in src/calc/payroll.ts (faithful port of the web engine);
 * these routes load the tenant snapshot, compute, and persist atomically.
 *
 *   POST /api/payroll/run              {month, employeeIds?, draft?}
 *   POST /api/payroll/finalize         {runId}
 *   POST /api/payroll/undo             {runId} or {month}
 *   POST /api/payroll/payslip/adjust   {runId, employeeId, adjustments[]}
 *   POST /api/payroll/payslip/reset    {runId, employeeId}
 *   POST /api/payroll/payslip/exclude  {runId, employeeId}
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError, resolveCompanyScope, type JwtUser } from '../db/collections';
import { withTransaction, type Queryable } from '../db/pool';
import { insertAudit } from '../lib/audit';
import {
  computeExcludeFromRun,
  computeFinalizeRun,
  computePayrollRun,
  computePayslipAdjustments,
  computePayslipReset,
  planPayrollUndo,
  type PayrollSnapshot,
} from '../calc/payroll';
import { resolveProrationMethod } from '../calc/workdays';
import type {
  AttendanceRecord, Claim, Employee, Holiday, LeaveRequest, PayrollRun, Payslip, PayslipAdjustment,
} from '../calc/types';

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

function requirePayrollRole(role: string): void {
  if (role !== 'Admin' && role !== 'HR' && role !== 'SuperAdmin') {
    throw new HttpError(403, 'Only Admin/HR can manage payroll.');
  }
}

function scopeOf(req: FastifyRequest, user: JwtUser): string {
  const q = (req.query ?? {}) as { companyId?: string };
  const h = req.headers['x-company-id'];
  const companyId = resolveCompanyScope(user, q.companyId ?? (typeof h === 'string' && h ? h : undefined));
  if (!companyId) throw new HttpError(400, 'SuperAdmin must pass ?companyId= for payroll operations.');
  return companyId;
}

function fail(reply: FastifyReply, err: unknown): unknown {
  if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
  throw err;
}

async function loadDocs<T>(db: Queryable, table: string, companyId: string): Promise<T[]> {
  const r = await db.query<{ id: string; data: Record<string, unknown> }>(
    `SELECT id, data FROM ${table} WHERE company_id = $1`,
    [companyId],
  );
  return r.rows.map((row) => ({ ...row.data, id: (row.data.id as string) ?? row.id }) as T);
}

async function loadSnapshot(db: Queryable, companyId: string): Promise<PayrollSnapshot> {
  const [employees, attendance, leaves, claims, payrollRuns, payslips, holidays, companyRow] =
    await Promise.all([
      loadDocs<Employee>(db, 'employees', companyId),
      loadDocs<AttendanceRecord>(db, 'attendance', companyId),
      loadDocs<LeaveRequest>(db, 'leaves', companyId),
      loadDocs<Claim>(db, 'claims', companyId),
      loadDocs<PayrollRun>(db, 'payroll_runs', companyId),
      loadDocs<Payslip>(db, 'payslips', companyId),
      db.query<{ data: Record<string, unknown> }>(
        'SELECT data FROM holidays WHERE company_id IS NULL',
      ),
      db.query<{ config: Record<string, unknown> }>(
        'SELECT config FROM companies WHERE id = $1',
        [companyId],
      ),
    ]);
  return {
    employees,
    attendance,
    leaves,
    claims,
    payrollRuns,
    payslips,
    holidayOverrides: holidays.rows.map((r) => r.data as unknown as Holiday),
    prorationMethod: resolveProrationMethod(companyRow.rows[0]?.config),
  };
}

async function upsertDocRow(
  db: Queryable,
  table: string,
  companyId: string,
  doc: Record<string, unknown>,
  extra: Record<string, unknown>,
): Promise<void> {
  const cols = ['company_id', 'id', 'data', ...Object.keys(extra)];
  const vals = [companyId, doc.id, JSON.stringify(doc), ...Object.values(extra)];
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const updates = ['data = EXCLUDED.data', 'updated_at = now()', ...Object.keys(extra).map((c) => `${c} = EXCLUDED.${c}`)];
  await db.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ` +
      `ON CONFLICT (company_id, id) DO UPDATE SET ${updates.join(', ')}`,
    vals,
  );
}

function upsertRun(db: Queryable, companyId: string, run: PayrollRun): Promise<void> {
  return upsertDocRow(db, 'payroll_runs', companyId, run as unknown as Record<string, unknown>, {
    month_key: run.monthKey,
  });
}

function upsertSlip(db: Queryable, companyId: string, slip: Payslip): Promise<void> {
  return upsertDocRow(db, 'payslips', companyId, slip as unknown as Record<string, unknown>, {
    run_id: slip.runId,
    employee_id: slip.employeeId,
    month_key: slip.monthKey,
  });
}

async function patchClaimPaid(
  db: Queryable,
  companyId: string,
  id: string,
  status: string,
  runId: string | null,
): Promise<void> {
  if (runId === null) {
    await db.query(
      `UPDATE claims SET status = $3,
         data = jsonb_set(data - 'paidInRunId', '{status}', to_jsonb($3::text)), updated_at = now()
       WHERE company_id = $1 AND id = $2`,
      [companyId, id, status],
    );
  } else {
    await db.query(
      `UPDATE claims SET status = $3,
         data = jsonb_set(jsonb_set(data, '{status}', to_jsonb($3::text)), '{paidInRunId}', to_jsonb($4::text)),
         updated_at = now()
       WHERE company_id = $1 AND id = $2`,
      [companyId, id, status, runId],
    );
  }
}

export default async function payrollRoutes(app: FastifyInstance): Promise<void> {
  const pre = { preHandler: [app.authenticate] };

  // ── Run ────────────────────────────────────────────────────────────────────
  app.post('/api/payroll/run', pre, async (req, reply) => {
    try {
      const user = req.hrmsUser;
      requirePayrollRole(user.role);
      const companyId = scopeOf(req, user);
      const body = (req.body ?? {}) as { month?: string; employeeIds?: string[]; draft?: boolean };
      const month = body.month ?? '';
      if (!MONTH_KEY.test(month)) throw new HttpError(400, "month must be 'YYYY-MM'.");
      if (body.employeeIds !== undefined && !Array.isArray(body.employeeIds)) {
        throw new HttpError(400, 'employeeIds must be an array of employee ids.');
      }

      const result = await withTransaction(async (client) => {
        const snapshot = await loadSnapshot(client, companyId);
        const change = computePayrollRun(snapshot, month, body.employeeIds, user.username, {
          draft: body.draft === true,
        });
        const { run } = change;

        if (change.priorRunIds.length > 0) {
          await client.query('DELETE FROM payroll_runs WHERE company_id = $1 AND id = ANY($2)', [
            companyId, change.priorRunIds,
          ]);
        }
        if (change.replacedSlipIds.length > 0) {
          await client.query('DELETE FROM payslips WHERE company_id = $1 AND id = ANY($2)', [
            companyId, change.replacedSlipIds,
          ]);
        }
        if (change.survivorSlipIds.length > 0) {
          await client.query(
            `UPDATE payslips SET run_id = $3, data = jsonb_set(data, '{runId}', to_jsonb($3::text)), updated_at = now()
             WHERE company_id = $1 AND id = ANY($2)`,
            [companyId, change.survivorSlipIds, run.id],
          );
        }
        for (const slip of change.payslips) await upsertSlip(client, companyId, slip);
        await upsertRun(client, companyId, run);
        for (const p of change.claimPatches) await patchClaimPaid(client, companyId, p.id, p.status, p.paidInRunId);
        await insertAudit(
          {
            companyId,
            actorId: user.userId,
            actorName: user.username,
            action: run.status === 'draft' ? 'payroll.draft' : 'payroll.run',
            entity: 'payrollRuns',
            entityId: run.id,
            detail: `${month}: ${run.employeeCount} payslips, net ${run.totalNet.toFixed(2)} (${run.status}, proration: ${run.prorationMethod ?? 'calendar'})`,
          },
          client,
        );
        return change;
      });

      return reply.send({ run: result.run, payslips: result.payslips });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ── Finalize ───────────────────────────────────────────────────────────────
  app.post('/api/payroll/finalize', pre, async (req, reply) => {
    try {
      const user = req.hrmsUser;
      requirePayrollRole(user.role);
      const companyId = scopeOf(req, user);
      const body = (req.body ?? {}) as { runId?: string };
      if (!body.runId) throw new HttpError(400, 'runId is required.');

      const result = await withTransaction(async (client) => {
        const snapshot = await loadSnapshot(client, companyId);
        const change = computeFinalizeRun(snapshot, body.runId!);
        if (!change) throw new HttpError(404, 'Payroll run not found.');
        await upsertRun(client, companyId, change.run);
        for (const p of change.claimPatches) await patchClaimPaid(client, companyId, p.id, p.status, p.paidInRunId);
        await insertAudit(
          {
            companyId,
            actorId: user.userId,
            actorName: user.username,
            action: 'payroll.finalize',
            entity: 'payrollRuns',
            entityId: change.run.id,
            detail: `${change.run.monthKey}: finalized, net ${change.run.totalNet.toFixed(2)}`,
          },
          client,
        );
        return change;
      });

      return reply.send({ run: result.run, claimsStamped: result.claimPatches.length });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ── Undo ───────────────────────────────────────────────────────────────────
  app.post('/api/payroll/undo', pre, async (req, reply) => {
    try {
      const user = req.hrmsUser;
      requirePayrollRole(user.role);
      const companyId = scopeOf(req, user);
      const body = (req.body ?? {}) as { month?: string; runId?: string };
      const month = body.month ?? '';
      if (!body.runId && !MONTH_KEY.test(month)) {
        throw new HttpError(400, "Provide runId, or month as 'YYYY-MM'.");
      }

      const plan = await withTransaction(async (client) => {
        const snapshot = await loadSnapshot(client, companyId);
        const p = planPayrollUndo(snapshot, month, body.runId);
        if (p.runIds.length === 0) throw new HttpError(404, 'No payroll run found to undo.');
        if (p.payslipIds.length > 0) {
          await client.query('DELETE FROM payslips WHERE company_id = $1 AND id = ANY($2)', [companyId, p.payslipIds]);
        }
        await client.query('DELETE FROM payroll_runs WHERE company_id = $1 AND id = ANY($2)', [companyId, p.runIds]);
        for (const id of p.claimIds) await patchClaimPaid(client, companyId, id, 'approved', null);
        await insertAudit(
          {
            companyId,
            actorId: user.userId,
            actorName: user.username,
            action: 'payroll.undo',
            entity: 'payrollRuns',
            entityId: p.runIds[0],
            detail: `Removed ${p.runIds.length} run(s), ${p.payslipIds.length} payslips; ${p.claimIds.length} claims back to approved`,
          },
          client,
        );
        return p;
      });

      return reply.send({ ok: true, ...plan });
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ── Draft payslip editing ──────────────────────────────────────────────────
  interface PayslipEditBody {
    runId?: string;
    employeeId?: string;
    adjustments?: PayslipAdjustment[];
  }

  function validateEditBody(body: PayslipEditBody): { runId: string; employeeId: string } {
    if (!body.runId || !body.employeeId) throw new HttpError(400, 'runId and employeeId are required.');
    return { runId: body.runId, employeeId: body.employeeId };
  }

  app.post('/api/payroll/payslip/adjust', pre, async (req, reply) => {
    try {
      const user = req.hrmsUser;
      requirePayrollRole(user.role);
      const companyId = scopeOf(req, user);
      const body = (req.body ?? {}) as PayslipEditBody;
      const { runId, employeeId } = validateEditBody(body);
      if (!Array.isArray(body.adjustments)) throw new HttpError(400, 'adjustments must be an array.');

      const result = await withTransaction(async (client) => {
        const snapshot = await loadSnapshot(client, companyId);
        const change = computePayslipAdjustments(snapshot, runId, employeeId, body.adjustments!);
        if (!change) throw new HttpError(404, 'Draft run or payslip not found (runs must be draft to edit).');
        await upsertSlip(client, companyId, change.payslip);
        await upsertRun(client, companyId, change.run);
        await insertAudit(
          {
            companyId,
            actorId: user.userId,
            actorName: user.username,
            action: 'payroll.payslip.adjust',
            entity: 'payslips',
            entityId: change.payslip.id,
            detail: `${change.run.monthKey} ${employeeId}: ${body.adjustments!.length} adjustment(s), net ${change.payslip.netPay.toFixed(2)}`,
          },
          client,
        );
        return change;
      });

      return reply.send({ run: result.run, payslip: result.payslip });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/payroll/payslip/reset', pre, async (req, reply) => {
    try {
      const user = req.hrmsUser;
      requirePayrollRole(user.role);
      const companyId = scopeOf(req, user);
      const { runId, employeeId } = validateEditBody((req.body ?? {}) as PayslipEditBody);

      const result = await withTransaction(async (client) => {
        const snapshot = await loadSnapshot(client, companyId);
        const change = computePayslipReset(snapshot, runId, employeeId);
        if (!change) throw new HttpError(404, 'Draft run or payslip not found (runs must be draft to edit).');
        await upsertSlip(client, companyId, change.payslip);
        await upsertRun(client, companyId, change.run);
        await insertAudit(
          {
            companyId,
            actorId: user.userId,
            actorName: user.username,
            action: 'payroll.payslip.reset',
            entity: 'payslips',
            entityId: change.payslip.id,
            detail: `${change.run.monthKey} ${employeeId}: reset to defaults, net ${change.payslip.netPay.toFixed(2)}`,
          },
          client,
        );
        return change;
      });

      return reply.send({ run: result.run, payslip: result.payslip });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/payroll/payslip/exclude', pre, async (req, reply) => {
    try {
      const user = req.hrmsUser;
      requirePayrollRole(user.role);
      const companyId = scopeOf(req, user);
      const { runId, employeeId } = validateEditBody((req.body ?? {}) as PayslipEditBody);

      const result = await withTransaction(async (client) => {
        const snapshot = await loadSnapshot(client, companyId);
        const change = computeExcludeFromRun(snapshot, runId, employeeId);
        if (!change || !change.removedSlipId) {
          throw new HttpError(404, 'Draft run or payslip not found (runs must be draft to edit).');
        }
        await client.query('DELETE FROM payslips WHERE company_id = $1 AND id = $2', [companyId, change.removedSlipId]);
        await upsertRun(client, companyId, change.run);
        await insertAudit(
          {
            companyId,
            actorId: user.userId,
            actorName: user.username,
            action: 'payroll.payslip.exclude',
            entity: 'payrollRuns',
            entityId: runId,
            detail: `${change.run.monthKey}: excluded employee ${employeeId} from the draft run`,
          },
          client,
        );
        return change;
      });

      return reply.send({ run: result.run, removedSlipId: result.removedSlipId });
    } catch (err) {
      return fail(reply, err);
    }
  });
}
