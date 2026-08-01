/**
 * Contracts module tests: status derivation (expiring/expired window),
 * statutoryApplies kind mapping, renewal chain (v1 → v2 draft linkage),
 * expiring filter, per-employee queries, dashboard stats and fee totals.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from './storageStub';
import { getCollection, setActiveTenantId } from '../db';
import type { AuditLog } from '../types';
import {
  CONTRACTS_COLLECTION,
  EXPIRING_WINDOW_DAYS,
  buildRenewalDraft,
  contractChain,
  contractStats,
  contractStatus,
  contractsFor,
  daysUntil,
  expiringContracts,
  feePaymentTotals,
  feePaymentsFor,
  renewContract,
  statutoryAppliesFor,
  terminateContract,
  type EmploymentContract,
  type FeePayment,
} from '../contracts';

beforeEach(() => {
  installLocalStorage();
  setActiveTenantId('co-asm');
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const TODAY = '2025-06-15';

let seq = 0;
function mk(overrides: Partial<EmploymentContract> = {}): EmploymentContract {
  seq += 1;
  return {
    id: `ct-${seq}`,
    kind: 'of-service',
    title: `Contract ${seq}`,
    refNo: `ASM-CT-2025-${String(seq).padStart(3, '0')}`,
    party: { companySigner: 'Datin Aisha Rahman' },
    startDate: '2025-01-01',
    status: 'active',
    remuneration: { mode: 'monthly-salary', amount: 5000, currency: 'MYR' },
    terms: { ipClause: true, confidentiality: true },
    statutoryApplies: statutoryAppliesFor(overrides.kind ?? 'of-service'),
    version: 1,
    createdAt: '2025-01-01T09:00:00.000Z',
    ...overrides,
  };
}

function fee(overrides: Partial<FeePayment> = {}): FeePayment {
  seq += 1;
  return {
    id: `fee-${seq}`,
    contractId: 'ct-1',
    date: '2025-05-31',
    reference: `INV-2025-${seq}`,
    amount: 1500,
    status: 'paid',
    createdAt: '2025-05-31T10:00:00.000Z',
    ...overrides,
  };
}

// ── statutoryApplies mapping ────────────────────────────────────────────────

describe('statutoryAppliesFor', () => {
  it('maps contract OF service → statutory applies (EA 1955 + EPF/SOCSO/EIS/PCB)', () => {
    expect(statutoryAppliesFor('of-service')).toBe(true);
  });

  it('maps contract FOR service → no statutory coverage', () => {
    expect(statutoryAppliesFor('for-service')).toBe(false);
  });
});

// ── Status derivation ───────────────────────────────────────────────────────

describe('contractStatus', () => {
  it('passes editorial states through untouched', () => {
    expect(contractStatus(mk({ status: 'draft', endDate: '2020-01-01' }), TODAY)).toBe('draft');
    expect(contractStatus(mk({ status: 'renewed', endDate: '2020-01-01' }), TODAY)).toBe('renewed');
    expect(contractStatus(mk({ status: 'terminated', endDate: '2020-01-01' }), TODAY)).toBe(
      'terminated',
    );
  });

  it('treats indefinite contracts (no endDate) as active', () => {
    expect(contractStatus(mk({ endDate: undefined }), TODAY)).toBe('active');
  });

  it('marks fixed-term contracts past end date as expired', () => {
    expect(contractStatus(mk({ endDate: '2025-06-14' }), TODAY)).toBe('expired');
    expect(contractStatus(mk({ endDate: '2024-12-31' }), TODAY)).toBe('expired');
  });

  it(`marks contracts ending within ${EXPIRING_WINDOW_DAYS} days as expiring`, () => {
    // exactly on the window boundary → expiring
    expect(contractStatus(mk({ endDate: '2025-08-14' }), TODAY)).toBe('expiring');
    // well inside the window
    expect(contractStatus(mk({ endDate: '2025-07-01' }), TODAY)).toBe('expiring');
    // ends today → expiring (not yet expired)
    expect(contractStatus(mk({ endDate: TODAY }), TODAY)).toBe('expiring');
  });

  it('keeps contracts ending beyond the window active', () => {
    expect(contractStatus(mk({ endDate: '2025-08-15' }), TODAY)).toBe('active');
    expect(contractStatus(mk({ endDate: '2026-06-15' }), TODAY)).toBe('active');
  });

  it('defaults to the real current date when today is omitted', () => {
    const farFuture = mk({ endDate: '2999-01-01' });
    expect(contractStatus(farFuture)).toBe('active');
  });
});

describe('daysUntil', () => {
  it('computes whole-day deltas in both directions', () => {
    expect(daysUntil('2025-06-15', '2025-06-15')).toBe(0);
    expect(daysUntil('2025-06-15', '2025-08-14')).toBe(60);
    expect(daysUntil('2025-08-14', '2025-06-15')).toBe(-60);
  });
});

// ── Renewal chain ───────────────────────────────────────────────────────────

describe('buildRenewalDraft', () => {
  it('creates a linked v+1 draft rolling the fixed term forward', () => {
    const v1 = mk({
      startDate: '2024-01-01',
      endDate: '2024-12-31',
      signedAt: '2023-12-20',
      signedBy: 'Employee One',
      refNo: 'ASM-CT-2024-001',
    });
    const draft = buildRenewalDraft(v1, '2024-12-01');
    expect(draft.version).toBe(2);
    expect(draft.parentContractId).toBe(v1.id);
    expect(draft.status).toBe('draft');
    expect(draft.startDate).toBe('2025-01-01'); // day after old end
    expect(draft.endDate).toBe('2025-12-31'); // same 364-day duration
    expect(draft.signedAt).toBeUndefined();
    expect(draft.signedBy).toBeUndefined();
    expect(draft.refNo).toBe('ASM-CT-2024-001-V2');
    expect(draft.kind).toBe(v1.kind);
    expect(draft.remuneration).toEqual(v1.remuneration);
  });

  it('replaces an existing -Vn suffix instead of stacking it', () => {
    const v2 = mk({ refNo: 'ASM-CT-2024-001-V2', version: 2, endDate: '2025-12-31' });
    expect(buildRenewalDraft(v2).refNo).toBe('ASM-CT-2024-001-V3');
  });

  it('renews indefinite contracts from today with no end date', () => {
    const v1 = mk({ endDate: undefined });
    const draft = buildRenewalDraft(v1, TODAY);
    expect(draft.startDate).toBe(TODAY);
    expect(draft.endDate).toBeUndefined();
  });
});

describe('renewContract (persisted)', () => {
  it('marks the current contract renewed and stores the linked draft', () => {
    const v1 = mk({ startDate: '2024-01-01', endDate: '2024-12-31' });
    setCollectionDirect([v1]);

    const draft = renewContract(v1.id, 'Tester', '2024-12-01');
    expect(draft).toBeDefined();
    expect(draft!.version).toBe(2);
    expect(draft!.parentContractId).toBe(v1.id);

    const stored = getCollection<EmploymentContract>(CONTRACTS_COLLECTION);
    expect(stored).toHaveLength(2);
    expect(stored.find((c) => c.id === v1.id)!.status).toBe('renewed');
    expect(stored.find((c) => c.id === draft!.id)!.status).toBe('draft');
  });

  it('writes an audit entry', () => {
    const v1 = mk();
    setCollectionDirect([v1]);
    renewContract(v1.id, 'Tester');
    const audit = getCollection<AuditLog>('audit');
    expect(audit.some((a) => a.action === 'contract.renew' && a.actorName === 'Tester')).toBe(true);
  });

  it('returns undefined for an unknown id', () => {
    setCollectionDirect([]);
    expect(renewContract('nope')).toBeUndefined();
  });
});

describe('contractChain', () => {
  it('walks v1 → v2 → v3 in chronological order from any link', () => {
    const v1 = mk({ id: 'c1', version: 1 });
    const v2 = mk({ id: 'c2', version: 2, parentContractId: 'c1' });
    const v3 = mk({ id: 'c3', version: 3, parentContractId: 'c2' });
    const all = [v3, v1, v2]; // unordered storage
    expect(contractChain(all, 'c2').map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(contractChain(all, 'c1').map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(contractChain(all, 'c3').map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('returns a single-node chain for an unlinked contract', () => {
    const solo = mk({ id: 'solo' });
    expect(contractChain([solo], 'solo').map((c) => c.id)).toEqual(['solo']);
  });
});

describe('terminateContract (persisted)', () => {
  it('stamps termination date + reason and audits it', () => {
    const c = mk();
    setCollectionDirect([c]);
    terminateContract(c.id, '2025-06-30', 'Mutual separation', 'Tester');
    const stored = getCollection<EmploymentContract>(CONTRACTS_COLLECTION)[0]!;
    expect(stored.status).toBe('terminated');
    expect(stored.terminatedAt).toBe('2025-06-30');
    expect(stored.terminationReason).toBe('Mutual separation');
    expect(
      getCollection<AuditLog>('audit').some((a) => a.action === 'contract.terminate'),
    ).toBe(true);
  });
});

// ── Queries & stats ─────────────────────────────────────────────────────────

describe('contractsFor', () => {
  it('filters by employee, latest version first', () => {
    const v1 = mk({ id: 'a1', employeeId: 'emp-1', version: 1, createdAt: '2024-01-01T00:00:00Z' });
    const v2 = mk({ id: 'a2', employeeId: 'emp-1', version: 2, createdAt: '2025-01-01T00:00:00Z' });
    const other = mk({ id: 'b1', employeeId: 'emp-2' });
    const none = mk({ id: 'c1', contractorName: 'External Consultant' });
    const result = contractsFor('emp-1', [v1, v2, other, none]);
    expect(result.map((c) => c.id)).toEqual(['a2', 'a1']);
  });

  it('reads from storage when no list is passed', () => {
    setCollectionDirect([mk({ employeeId: 'emp-9' }), mk({ employeeId: 'emp-1' })]);
    expect(contractsFor('emp-9')).toHaveLength(1);
  });
});

describe('expiringContracts', () => {
  const contracts = [
    mk({ id: 'soon', endDate: '2025-07-10' }), // 25 days out
    mk({ id: 'sooner', endDate: '2025-06-20' }), // 5 days out
    mk({ id: 'later', endDate: '2025-12-31' }), // outside 60d window
    mk({ id: 'gone', endDate: '2025-06-01' }), // already past
    mk({ id: 'draft', status: 'draft', endDate: '2025-07-01' }),
    mk({ id: 'indef', endDate: undefined }),
  ];

  it('returns active fixed-term contracts inside the window, soonest first', () => {
    const result = expiringContracts(60, TODAY, contracts);
    expect(result.map((c) => c.id)).toEqual(['sooner', 'soon']);
  });

  it('honours a custom window', () => {
    expect(expiringContracts(10, TODAY, contracts).map((c) => c.id)).toEqual(['sooner']);
    expect(expiringContracts(200, TODAY, contracts).map((c) => c.id)).toEqual([
      'sooner',
      'soon',
      'later',
    ]);
  });

  it('reads from storage when no list is passed', () => {
    setCollectionDirect([mk({ endDate: '2025-07-01' })]);
    expect(expiringContracts(60, TODAY)).toHaveLength(1);
  });
});

describe('contractStats', () => {
  it('counts kind, expiring, expired-unrenewed and editorial buckets', () => {
    const expiredV1 = mk({ id: 'x1', endDate: '2025-01-31', status: 'renewed' });
    const successor = mk({ id: 'x2', parentContractId: 'x1', status: 'draft', version: 2 });
    const contracts = [
      mk({ id: 'os1', kind: 'of-service' }), // active of-service
      mk({ id: 'fs1', kind: 'for-service' }), // active for-service
      mk({ id: 'ex1', endDate: '2025-07-01' }), // expiring (counts as active too)
      mk({ id: 'xp1', endDate: '2025-01-31' }), // expired, no successor
      expiredV1, // renewed — has successor, not "expired-unrenewed"
      successor, // draft
      mk({ id: 't1', status: 'terminated' }),
    ];
    const stats = contractStats(contracts, TODAY);
    expect(stats.activeOfService).toBe(2); // os1 + expiring ex1
    expect(stats.activeForService).toBe(1);
    expect(stats.expiringSoon).toBe(1);
    expect(stats.expiredUnrenewed).toBe(1); // only xp1
    expect(stats.drafts).toBe(1);
    expect(stats.terminated).toBe(1);
    expect(stats.total).toBe(7);
  });
});

// ── Fee payments (for-service) ──────────────────────────────────────────────

describe('fee payments', () => {
  it('feePaymentsFor filters and sorts newest first', () => {
    const payments = [
      fee({ id: 'f1', contractId: 'c1', date: '2025-03-31' }),
      fee({ id: 'f2', contractId: 'c1', date: '2025-05-31' }),
      fee({ id: 'f3', contractId: 'c2', date: '2025-04-30' }),
    ];
    expect(feePaymentsFor('c1', payments).map((p) => p.id)).toEqual(['f2', 'f1']);
  });

  it('feePaymentTotals splits paid/pending gross (no statutory deductions)', () => {
    const totals = feePaymentTotals([
      fee({ amount: 1000, status: 'paid' }),
      fee({ amount: 2500.55, status: 'paid' }),
      fee({ amount: 800, status: 'pending' }),
    ]);
    expect(totals.paid).toBe(3500.55);
    expect(totals.pending).toBe(800);
    expect(totals.total).toBe(4300.55);
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

import { setCollection } from '../db';
function setCollectionDirect(contracts: EmploymentContract[]): void {
  setCollection(CONTRACTS_COLLECTION, contracts);
}
