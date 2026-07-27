import { describe, it, expect, beforeEach } from 'vitest';
import { installLocalStorage } from './storageStub';
import { setCollection } from '../db';
import {
  getOfficeLocations,
  getClaimPolicy,
  getLeaveTopUps,
  getPayrollCutoff,
  DEFAULT_CLAIM_POLICY,
  DEFAULT_CLAIM_LIMITS,
  ZERO_LEAVE_TOPUPS,
} from '../appSettings';

beforeEach(() => {
  installLocalStorage();
});

describe('getOfficeLocations', () => {
  it('returns [] when no settings exist', () => {
    expect(getOfficeLocations()).toEqual([]);
  });

  it('reads the canonical officeLocations field on the company singleton', () => {
    setCollection('settings', [
      {
        id: 'company',
        officeLocations: [
          { id: 'hq', name: 'HQ', address: 'KL', lat: 3.15, lng: 101.7, radiusM: 200, radiusMeters: 200 },
        ],
      },
    ]);
    const locs = getOfficeLocations();
    expect(locs).toHaveLength(1);
    expect(locs[0]).toMatchObject({ id: 'hq', name: 'HQ', lat: 3.15, lng: 101.7, radiusM: 200 });
  });

  it('respects a deliberate empty array (never falls back to legacy rows)', () => {
    setCollection('settings', [
      { id: 'company', officeLocations: [] },
      { id: 'loc-1', kind: 'officeLocation', name: 'Legacy', lat: 3, lng: 101, radiusMeters: 300 },
    ]);
    expect(getOfficeLocations()).toEqual([]);
  });

  it('falls back to legacy kind:officeLocation rows (radiusMeters → radiusM)', () => {
    setCollection('settings', [
      { id: 'company' },
      { id: 'loc-1', kind: 'officeLocation', name: 'Legacy HQ', lat: 3.1, lng: 101.6, radiusMeters: 350 },
    ]);
    const locs = getOfficeLocations();
    expect(locs).toHaveLength(1);
    expect(locs[0]).toMatchObject({ id: 'loc-1', name: 'Legacy HQ', radiusM: 350 });
  });

  it('drops entries without finite coordinates', () => {
    setCollection('settings', [
      { id: 'company', officeLocations: [{ id: 'bad', name: 'Bad', lat: 'x', lng: 101 }] },
    ]);
    expect(getOfficeLocations()).toEqual([]);
  });
});

describe('getClaimPolicy', () => {
  it('returns module defaults when no docs exist', () => {
    const p = getClaimPolicy();
    expect(p).toMatchObject(DEFAULT_CLAIM_POLICY);
    expect(p.monthlyLimits).toEqual(DEFAULT_CLAIM_LIMITS);
  });

  it('claimPolicy doc overrides the scalar fields', () => {
    setCollection('settings', [{ id: 'claimPolicy', mileageRatePerKm: 1.2, mealDailyLimit: 80 }]);
    const p = getClaimPolicy();
    expect(p.mileageRatePerKm).toBe(1.2);
    expect(p.mealDailyLimit).toBe(80);
    expect(p.medicalClaimLimit).toBe(DEFAULT_CLAIM_POLICY.medicalClaimLimit);
  });

  it('legacy ext:payroll claimLimits still surface via monthlyLimits', () => {
    setCollection('settings', [
      {
        id: 'ext:payroll',
        kind: 'payrollPolicy',
        cutoffDay: 25,
        workingDaysBasis: 26,
        claimLimits: { meal: 450, travel: 900 },
      },
    ]);
    const p = getClaimPolicy();
    expect(p.monthlyLimits.meal).toBe(450);
    expect(p.monthlyLimits.travel).toBe(900);
    expect(p.monthlyLimits.medical).toBe(DEFAULT_CLAIM_LIMITS.medical);
  });
});

describe('getLeaveTopUps', () => {
  it('returns zero top-ups when the record is absent', () => {
    expect(getLeaveTopUps()).toEqual(ZERO_LEAVE_TOPUPS);
  });

  it('reads days from ext:leaveTopups, tolerating partial/invalid values', () => {
    setCollection('settings', [
      { id: 'ext:leaveTopups', kind: 'leaveTopups', days: { annual: 3, sick: -2, maternity: 'x' } },
    ]);
    const t = getLeaveTopUps();
    expect(t.annual).toBe(3);
    expect(t.sick).toBe(0);      // negative → clamped to 0
    expect(t.maternity).toBe(0); // non-numeric → 0
    expect(t.hospitalization).toBe(0);
    expect(t.paternity).toBe(0);
  });
});

describe('getPayrollCutoff', () => {
  it('defaults to cutoffDay 25 / workingDaysBasis 26', () => {
    expect(getPayrollCutoff()).toEqual({ cutoffDay: 25, workingDaysBasis: 26 });
  });

  it('reads ext:payroll overrides and clamps the day to 1–28', () => {
    setCollection('settings', [
      { id: 'ext:payroll', kind: 'payrollPolicy', cutoffDay: 31, workingDaysBasis: 22 },
    ]);
    expect(getPayrollCutoff()).toEqual({ cutoffDay: 28, workingDaysBasis: 22 });
  });
});
