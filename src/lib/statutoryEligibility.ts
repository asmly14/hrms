/**
 * Per-employee statutory applicability — AUTO resolution + employer override.
 *
 * Model (Employee, additive — null/undefined = AUTO):
 *  - epfApplicable?: boolean | null   — EPF (KWSP) standing rule
 *  - socsoApplicable?: boolean | null — SOCSO (PERKESO) standing rule;
 *    EIS follows SOCSO applicability (both are PERKESO Acts tied to a
 *    contract of service).
 *
 * AUTO rules (docs/research/statutory-rates.md §1–3, employment-law.md):
 *  - Contract FOR service — an in-force (active / expiring) linked contract
 *    with kind 'for-service' marks an independent contractor, NOT an employee
 *    under a contract of service: EPF, SOCSO and EIS are all NOT applicable
 *    (EPF Act 1991 s.2 "employee"; Act 4 s.2; Act 800 coverage tied to a
 *    contract of service). Fees are paid gross against invoices.
 *  - Everyone else (full-time / part-time / contract OF service, with or
 *    without a linked contract record) → all applicable. Citizen/PR vs
 *    foreign-worker rates and the age 60+/75+ branches stay inside
 *    lib/statutory.ts (calcEPF/calcSOCSO/calcEIS) — this module only decides
 *    WHETHER a scheme applies, never the rate.
 *
 * An explicit boolean on the employee record is an EMPLOYER OVERRIDE and
 * always wins over the automatic rule (e.g. forcing EPF on for a consultant,
 * or marking a director not applicable). Per-scheme: overriding EPF never
 * touches the SOCSO/EIS resolution and vice versa.
 *
 * This module is the single source of truth — payrollEngine, the employee
 * forms, the detail page and the payslip editor all resolve through it.
 */

import { getCollection } from './db';
import {
  CONTRACTS_COLLECTION, CONTRACT_KIND_LABELS, contractStatus,
  type EmploymentContract,
} from './contracts';
import { ageFromDob } from './utils';
import type { EmploymentType } from './types';

/** Minimal shape the resolver needs (Employee satisfies it; forms pass a partial). */
export type StatutorySubject = {
  /** Employee id — needed to link contracts; absent = no linked contracts. */
  id?: string;
  employmentType?: EmploymentType;
  isForeignWorker?: boolean;
  dateOfBirth?: string; // ISO date — used for age edge notes only
  epfApplicable?: boolean | null;
  socsoApplicable?: boolean | null;
};

export interface StatutoryEligibility {
  epf: boolean;
  socso: boolean;
  /** EIS follows SOCSO applicability (Act 800 rides the Act 4 coverage). */
  eis: boolean;
  /** 'override' when at least one scheme carries an explicit employer flag. */
  source: 'override' | 'auto';
  /** Human-readable explanation of the resolution (UI captions, audit). */
  reasons: string[];
  /** Short auto-basis phrase, e.g. "linked contract for service ASM-CT-2025-001"
   *  or "full-time employee (contract of service)" — for 'Auto: …' captions. */
  autoBasis: string;
  /** Payslip info line when EPF is not applicable (e.g. 'EPF not applicable —
   *  contract for service'); undefined when EPF applies. */
  epfReason?: string;
  /** Payslip info line when SOCSO is not applicable. */
  socsoReason?: string;
  /** Payslip info line when EIS is not applicable (follows SOCSO). */
  eisReason?: string;
}

const EMPLOYMENT_TYPE_PHRASE: Record<EmploymentType, string> = {
  'full-time': 'full-time employee (contract of service)',
  'part-time': 'part-time employee (contract of service)',
  contract: 'contract employee (contract of service)',
};

/** In-force linked contract = stored 'active' and not past its end date.
 *  'expiring' (end within 60 days) is still in force; draft / renewed /
 *  terminated / expired records never drive applicability. */
function inForceLinkedContracts(
  emp: StatutorySubject,
  contracts: EmploymentContract[],
): EmploymentContract[] {
  if (!emp.id) return [];
  return contracts.filter(
    (c) =>
      c.employeeId === emp.id &&
      (contractStatus(c) === 'active' || contractStatus(c) === 'expiring'),
  );
}

/**
 * Resolve EPF/SOCSO/EIS applicability for an employee.
 *
 * @param emp       Employee (or the minimal StatutorySubject shape).
 * @param contracts Contracts collection snapshot — defaults to the live
 *                  collection so UI callers can omit it; the payroll engine
 *                  passes its per-run snapshot for consistency.
 * @param asOf      Date for age edge notes (engine passes the wage month's
 *                  reference date); defaults to now.
 */
export function resolveStatutoryEligibility(
  emp: StatutorySubject,
  contracts?: EmploymentContract[],
  asOf: Date = new Date(),
): StatutoryEligibility {
  const list = contracts ?? getCollection<EmploymentContract>(CONTRACTS_COLLECTION);
  const reasons: string[] = [];

  // ── AUTO base ──
  const linked = inForceLinkedContracts(emp, list);
  const forService = linked.find((c) => c.kind === 'for-service');
  const ofService = linked.find((c) => c.kind === 'of-service');

  let autoEpf = true;
  let autoSocso = true;
  let autoBasis: string;

  if (forService) {
    autoEpf = false;
    autoSocso = false;
    autoBasis = `linked contract for service ${forService.refNo}`;
    reasons.push(
      `${forService.refNo} is a ${CONTRACT_KIND_LABELS['for-service']} — an independent ` +
        `contractor is not an employee under a contract of service, so EPF (EPF Act 1991 s.2), ` +
        `SOCSO (Act 4 s.2) and EIS (Act 800) do not apply.`,
    );
  } else {
    const typePhrase = EMPLOYMENT_TYPE_PHRASE[emp.employmentType ?? 'full-time'];
    autoBasis = ofService
      ? `linked ${CONTRACT_KIND_LABELS['of-service'].toLowerCase()} ${ofService.refNo}`
      : typePhrase;
    reasons.push(
      `${typePhrase[0]!.toUpperCase()}${typePhrase.slice(1)}` +
        (ofService ? ` (linked contract ${ofService.refNo})` : '') +
        ` — EPF, SOCSO and EIS apply.`,
    );
  }

  // ── Age / nationality edge notes (informational — the RATE branches live in
  //    lib/statutory.ts and keep applying downstream; applicability stays ON) ──
  const age =
    emp.dateOfBirth && !Number.isNaN(new Date(`${emp.dateOfBirth}T00:00:00`).getTime())
      ? ageFromDob(emp.dateOfBirth, asOf)
      : undefined;
  if (age !== undefined && age >= 75) {
    reasons.push('Age 75+: EPF contributions are nil under the Third Schedule — applied automatically.');
  } else if (age !== undefined && age >= 60) {
    reasons.push(
      'Age 60+: EPF employee share 0% / employer 4% for citizens (Third Schedule s.E), ' +
        'SOCSO Second Category (employer-only), EIS exempt (Act 800) — applied automatically.',
    );
  }
  if (emp.isForeignWorker) {
    reasons.push(
      'Foreign worker: EPF 2% employee + 2% employer mandatory from 1 Oct 2025 ' +
        '(EPF (Amendment) Act 2025); EIS exempt (Act 800 s.18) — applied automatically.',
    );
  }

  // ── Employer overrides (win over the automatic rule, per scheme) ──
  const epfOverride = typeof emp.epfApplicable === 'boolean' ? emp.epfApplicable : undefined;
  const socsoOverride = typeof emp.socsoApplicable === 'boolean' ? emp.socsoApplicable : undefined;

  if (epfOverride !== undefined) {
    reasons.push(
      `EPF applicability set by employer override → ${epfOverride ? 'applicable' : 'not applicable'}.`,
    );
  }
  if (socsoOverride !== undefined) {
    reasons.push(
      `SOCSO applicability set by employer override → ${socsoOverride ? 'applicable' : 'not applicable'} (EIS follows SOCSO).`,
    );
  }

  const epf = epfOverride ?? autoEpf;
  const socso = socsoOverride ?? autoSocso;
  const eis = socso; // EIS follows SOCSO applicability

  const naReason = (scheme: string, override: boolean | undefined): string =>
    override === false
      ? `${scheme} not applicable — employer override (employee record)`
      : `${scheme} not applicable — contract for service`;

  return {
    epf,
    socso,
    eis,
    source: epfOverride !== undefined || socsoOverride !== undefined ? 'override' : 'auto',
    reasons,
    autoBasis,
    ...(!epf ? { epfReason: naReason('EPF', epfOverride) } : {}),
    ...(!socso ? { socsoReason: naReason('SOCSO', socsoOverride) } : {}),
    ...(!eis ? { eisReason: naReason('EIS', socsoOverride) } : {}),
  };
}

/** Form tri-state ← stored flag (null/undefined = 'auto'). */
export function applicabilityToTriState(flag: boolean | null | undefined): 'auto' | 'yes' | 'no' {
  return flag === true ? 'yes' : flag === false ? 'no' : 'auto';
}

/** Stored flag ← form tri-state. 'auto' persists as null so a previous
 *  override is explicitly cleared (undefined keys are dropped on save). */
export function triStateToApplicability(v: 'auto' | 'yes' | 'no'): boolean | null {
  return v === 'auto' ? null : v === 'yes';
}
