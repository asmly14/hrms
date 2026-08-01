/**
 * Onboarding-portal tests: token generation, link CRUD + expiry, cross-tenant
 * token resolution, submission → employee mapping, approve/reject workflow,
 * records-extension extras, document size cap. Mirrors the lib test style
 * with the in-memory storage stub.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installLocalStorage } from './storageStub';
import {
  getCollection,
  setActiveTenantId,
  upsertCompany,
  type CollectionName,
} from '../db';
import { companySeedRecord } from '../tenants';
import type { OnboardingChecklist } from '../lifecycle';
import type { AuditLog, Employee } from '../types';
import {
  MAX_FILE_BYTES,
  approveSubmission,
  attachOnboardingExtras,
  buildEmployeeFromSubmission,
  buildOnboardUrl,
  createOnboardLink,
  effectiveLinkStatus,
  findLinkByToken,
  generateToken,
  getOnboardLinks,
  getOnboardingExtras,
  getSubmission,
  getSubmissions,
  isLinkExpired,
  isValidIc,
  latestSubmissionForLink,
  normalizeIc,
  rejectSubmission,
  resolvePublicLink,
  revokeOnboardLink,
  submitOnboardForm,
  validateDocumentFile,
  type ApproveOverrides,
  type OnboardDraft,
} from '../onboardLinks';

const CO = 'co-asm';
const CO_B = 'co-merdeka';

beforeEach(() => {
  installLocalStorage();
  upsertCompany(companySeedRecord(CO));
  setActiveTenantId(CO);
});

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeDraft(overrides: Partial<OnboardDraft> = {}): OnboardDraft {
  return {
    personal: {
      name: 'Aisyah binti Rahman',
      ic: '950312-10-5566',
      dob: '1995-03-12',
      gender: 'female',
      maritalStatus: 'single',
      phone: '012-3456789',
      email: 'aisyah@example.com',
      address: 'No. 12, Jalan SS 2/1, 47300 Petaling Jaya',
      state: 'SGR',
      nationality: 'Malaysian',
      bankName: 'Maybank',
      bankAccount: '162012345678',
      epfNo: '12345678',
    },
    emergencyContacts: [{ name: 'Rahman bin Ali', relation: 'Father', phone: '019-9998887' }],
    academics: [
      {
        level: 'Degree',
        institution: 'Universiti Malaya',
        course: 'BSc (Hons) Computer Science',
        fromYear: '2014',
        toYear: '2018',
        grade: '3.75',
      },
    ],
    employment: {
      positionId: 'pos-1',
      departmentId: 'dept-1',
      joinDate: '2026-03-02',
      employmentType: 'full-time',
    },
    documents: [
      {
        kind: 'IC',
        fileName: 'ic.jpg',
        dataUrl: 'data:image/jpeg;base64,QUJD',
        sizeBytes: 120_000,
        uploadedAt: '2026-02-20T01:00:00.000Z',
      },
    ],
    declarationAccepted: true,
    ...overrides,
  };
}

function makeLink(label = 'Aisyah binti Rahman', companyId = CO) {
  return createOnboardLink({ label, companyId, createdBy: 'HR Admin' });
}

function makeSubmission() {
  const link = makeLink();
  const res = submitOnboardForm(link, makeDraft());
  if (!res.ok) throw new Error('fixture submit failed');
  return { link: getOnboardLinks(CO).find((l) => l.id === link.id)!, submission: res.submission };
}

const APPROVE: ApproveOverrides = {
  baseSalary: 3500,
  positionId: 'pos-1',
  departmentId: 'dept-1',
  joinDate: '2026-03-02',
  employmentType: 'full-time',
  reviewer: 'HR Admin',
};

// ── Token & helpers ─────────────────────────────────────────────────────────

describe('generateToken', () => {
  it('produces 24-char URL-safe tokens', () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });

  it('is effectively unique', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken()));
    expect(tokens.size).toBe(200);
  });
});

describe('NRIC helpers', () => {
  it('normalizes dashless input to ######-##-####', () => {
    expect(normalizeIc('950312105566')).toBe('950312-10-5566');
    expect(normalizeIc('950312-10-5566')).toBe('950312-10-5566');
  });

  it('leaves non-12-digit input alone (trimmed)', () => {
    expect(normalizeIc(' A1234567 ')).toBe('A1234567');
  });

  it('validates the dashed shape', () => {
    expect(isValidIc('950312-10-5566')).toBe(true);
    expect(isValidIc('950312105566')).toBe(false);
    expect(isValidIc('12345')).toBe(false);
  });
});

describe('buildOnboardUrl', () => {
  it('joins origin + base + token', () => {
    expect(buildOnboardUrl('tok_123', 'https://hr.example.com')).toBe(
      'https://hr.example.com/onboard/tok_123',
    );
  });
});

describe('validateDocumentFile', () => {
  it('rejects files over the cap with a friendly message', () => {
    const msg = validateDocumentFile('scan.pdf', MAX_FILE_BYTES + 1);
    expect(msg).toContain('scan.pdf');
    expect(msg).toContain('700 KB');
  });

  it('accepts files at or under the cap', () => {
    expect(validateDocumentFile('scan.pdf', MAX_FILE_BYTES)).toBeNull();
    expect(validateDocumentFile('scan.pdf', 50_000)).toBeNull();
  });
});

// ── Link CRUD, expiry, token resolution ─────────────────────────────────────

describe('createOnboardLink', () => {
  it('defaults to active with a 14-day expiry and writes an audit entry', () => {
    const link = createOnboardLink({
      label: 'Aisyah',
      companyId: CO,
      createdBy: 'HR Admin',
      now: new Date(2026, 1, 10, 12, 0, 0), // local noon — TZ-proof
    });
    expect(link.status).toBe('active');
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(link.expiresAt.slice(0, 10)).toBe('2026-02-24');
    expect(getOnboardLinks(CO)).toHaveLength(1);
    const audit = getCollection<AuditLog>('audit', CO);
    expect(audit.some((a) => a.action === 'onboard.link.create')).toBe(true);
  });

  it('stores links per tenant (isolation)', () => {
    makeLink('A', CO);
    expect(getOnboardLinks(CO_B)).toHaveLength(0);
  });
});

describe('findLinkByToken / resolvePublicLink', () => {
  it('finds links across tenants by token', () => {
    upsertCompany(companySeedRecord(CO_B));
    makeLink('A', CO);
    const b = makeLink('B', CO_B);
    expect(findLinkByToken(b.token)?.companyId).toBe(CO_B);
    expect(findLinkByToken('no-such-token')).toBeUndefined();
  });

  it('resolves an active link with its company branding', () => {
    const link = makeLink();
    const r = resolvePublicLink(link.token);
    expect(r.reason).toBe('ok');
    expect(r.company?.id).toBe(CO);
    expect(r.company?.branding.logoText).toBe('ASM');
  });

  it('reports unknown tokens as not-found', () => {
    expect(resolvePublicLink('nope').reason).toBe('not-found');
  });

  it('transitions past-expiry links to expired (persisted)', () => {
    const link = createOnboardLink({
      label: 'Late',
      companyId: CO,
      createdBy: 'HR',
      expiryDays: 1,
      now: new Date(2026, 1, 1, 12, 0, 0),
    });
    const r = resolvePublicLink(link.token, new Date(2026, 1, 3, 12, 0, 0));
    expect(r.reason).toBe('expired');
    expect(getOnboardLinks(CO)[0]!.status).toBe('expired');
  });

  it('reports revoked links', () => {
    const link = makeLink();
    revokeOnboardLink(link, 'HR Admin');
    expect(resolvePublicLink(link.token).reason).toBe('revoked');
    const audit = getCollection<AuditLog>('audit', CO);
    expect(audit.some((a) => a.action === 'onboard.link.revoke')).toBe(true);
  });

  it('reports submitted links as under review', () => {
    const { link } = makeSubmission();
    expect(resolvePublicLink(link.token).reason).toBe('submitted');
  });
});

describe('expiry helpers', () => {
  const makeOld = () =>
    createOnboardLink({
      label: 'T',
      companyId: CO,
      createdBy: 'HR',
      expiryDays: 1,
      now: new Date(2026, 1, 1, 12, 0, 0),
    });

  it('isLinkExpired is time-based', () => {
    const base = makeOld();
    expect(isLinkExpired(base, new Date(2026, 1, 1, 13, 0, 0))).toBe(false);
    expect(isLinkExpired(base, new Date(2026, 1, 5, 12, 0, 0))).toBe(true);
  });

  it('effectiveLinkStatus applies expiry only to active links', () => {
    const base = makeOld();
    const later = new Date(2026, 1, 5, 12, 0, 0);
    expect(effectiveLinkStatus(base, later)).toBe('expired');
    expect(effectiveLinkStatus({ ...base, status: 'approved' }, later)).toBe('approved');
    expect(effectiveLinkStatus(base, new Date(2026, 1, 1, 13, 0, 0))).toBe('active');
  });
});

// ── Submission flow ─────────────────────────────────────────────────────────

describe('submitOnboardForm', () => {
  it('stores the submission and flips the link to submitted', () => {
    const { link, submission } = makeSubmission();
    expect(submission.reviewStatus).toBe('pending');
    expect(submission.companyId).toBe(CO);
    expect(link.status).toBe('submitted');
    expect(link.submissionId).toBe(submission.id);
    expect(getSubmissions(CO)).toHaveLength(1);
    const audit = getCollection<AuditLog>('audit', CO);
    expect(audit.some((a) => a.action === 'onboard.submit')).toBe(true);
  });
});

describe('rejectSubmission → resubmit', () => {
  it('marks the submission rejected and re-opens the link', () => {
    const { link, submission } = makeSubmission();
    rejectSubmission(submission, 'IC copy is blurry', 'HR Admin');

    expect(getSubmission(submission.id, CO)?.reviewStatus).toBe('rejected');
    expect(getSubmission(submission.id, CO)?.reviewNotes).toBe('IC copy is blurry');
    const reopened = getOnboardLinks(CO).find((l) => l.id === link.id)!;
    expect(reopened.status).toBe('active');
    expect(reopened.submissionId).toBeUndefined();

    // The public resolver hands the rejected submission back for prefill.
    const r = resolvePublicLink(link.token);
    expect(r.reason).toBe('ok');
    expect(r.resubmission?.id).toBe(submission.id);

    // Resubmission creates a second record; latest wins.
    const res2 = submitOnboardForm(reopened, makeDraft());
    expect(res2.ok).toBe(true);
    expect(getSubmissions(CO)).toHaveLength(2);
    expect(latestSubmissionForLink(link.id, CO)?.id).toBe(
      res2.ok ? res2.submission.id : 'unreachable',
    );
  });
});

// ── Employee mapping & approval ─────────────────────────────────────────────

describe('buildEmployeeFromSubmission', () => {
  it('maps every Employee field from the submission + overrides', () => {
    const { submission } = makeSubmission();
    const emp = buildEmployeeFromSubmission(submission, APPROVE);

    expect(emp.name).toBe('Aisyah binti Rahman');
    expect(emp.ic).toBe('950312-10-5566');
    expect(emp.email).toBe('aisyah@example.com');
    expect(emp.departmentId).toBe('dept-1');
    expect(emp.positionId).toBe('pos-1');
    expect(emp.role).toBe('employee');
    expect(emp.status).toBe('probation');
    expect(emp.baseSalary).toBe(3500);
    expect(emp.state).toBe('SGR');
    expect(emp.employmentType).toBe('full-time');
    expect(emp.bankName).toBe('Maybank');
    expect(emp.bankAccount).toBe('162012345678');
    expect(emp.epfNo).toBe('12345678');
    expect(emp.socsoNo).toBe(''); // optional statutory numbers default blank
    expect(emp.taxNo).toBe('');
    expect(emp.children).toBe(0);
    expect(emp.isForeignWorker).toBe(false);
    expect(emp.dateOfBirth).toBe('1995-03-12');
    expect(emp.gender).toBe('female');
    expect(emp.maritalStatus).toBe('single');
    expect(emp.employeeNo).toMatch(/^ASM\d{4}$/); // company prefix from seed
  });

  it('normalizes dashless NRICs and derives foreign-worker flag', () => {
    const link = makeLink();
    const draft = makeDraft();
    draft.personal = { ...draft.personal, ic: '950312105566', nationality: 'Singaporean' };
    const res = submitOnboardForm(link, draft);
    if (!res.ok) throw new Error('submit failed');
    const emp = buildEmployeeFromSubmission(res.submission, APPROVE);
    expect(emp.ic).toBe('950312-10-5566');
    expect(emp.isForeignWorker).toBe(true);
  });
});

describe('approveSubmission', () => {
  it('creates the employee, extras, checklist and closes the loop', () => {
    const { link, submission } = makeSubmission();
    const result = approveSubmission(submission, APPROVE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Employee record in the company tenant
    const employees = getCollection<Employee>('employees', CO);
    expect(employees).toHaveLength(1);
    expect(employees[0]!.id).toBe(result.employee.id);
    expect(employees[0]!.employeeNo).toBe(result.employee.employeeNo);

    // Records extension, keyed by employeeId — manifest only, no dataUrl copies
    const extras = getOnboardingExtras(result.employee.id, CO);
    expect(extras?.submissionId).toBe(submission.id);
    expect(extras?.academics).toHaveLength(1);
    expect(extras?.emergencyContacts).toHaveLength(1);
    expect(extras?.documents).toHaveLength(1);
    // Manifest carries no bytes — the dataUrl key is absent by design.
    expect(extras?.documents[0] && 'dataUrl' in extras.documents[0]).toBe(false);
    expect(extras?.declarationAccepted).toBe(true);
    // …while the bytes stay retrievable on the submission record
    expect(getSubmission(submission.id, CO)?.documents[0]?.dataUrl).toContain('data:image');

    // Onboarding checklist seeded from the lifecycle templates
    const checklists = getCollection<OnboardingChecklist>(
      'onboardingChecklists' as CollectionName,
      CO,
    );
    expect(checklists).toHaveLength(1);
    expect(checklists[0]!.employeeId).toBe(result.employee.id);
    expect(checklists[0]!.template).toBe('standard');

    // Submission + link trail
    const storedSub = getSubmission(submission.id, CO);
    expect(storedSub?.reviewStatus).toBe('approved');
    expect(storedSub?.employeeId).toBe(result.employee.id);
    expect(storedSub?.reviewedBy).toBe('HR Admin');
    expect(getOnboardLinks(CO).find((l) => l.id === link.id)?.status).toBe('approved');

    // Public resolver now reports the link as approved
    expect(resolvePublicLink(link.token).reason).toBe('approved');

    const audit = getCollection<AuditLog>('audit', CO);
    expect(audit.some((a) => a.action === 'onboard.approve')).toBe(true);
  });

  it('uses the contract template for contract hires', () => {
    const { submission } = makeSubmission();
    const result = approveSubmission(submission, { ...APPROVE, employmentType: 'contract' });
    expect(result.ok).toBe(true);
    const checklists = getCollection<OnboardingChecklist>(
      'onboardingChecklists' as CollectionName,
      CO,
    );
    expect(checklists[0]!.template).toBe('contract');
  });

  it('rejects invalid approval input without side effects', () => {
    const { submission } = makeSubmission();
    const bad = approveSubmission(submission, { ...APPROVE, baseSalary: 0 });
    expect(bad.ok).toBe(false);
    const noDept = approveSubmission(submission, { ...APPROVE, departmentId: '' });
    expect(noDept.ok).toBe(false);
    expect(getCollection<Employee>('employees', CO)).toHaveLength(0);
  });
});

describe('attachOnboardingExtras', () => {
  it('round-trips extras keyed by employeeId and upserts on re-attach', () => {
    const { submission } = makeSubmission();
    attachOnboardingExtras('emp-1', submission);
    attachOnboardingExtras('emp-1', submission); // idempotent replace
    const extras = getOnboardingExtras('emp-1', CO);
    expect(extras?.employeeId).toBe('emp-1');
    expect(extras?.homeState).toBe('SGR');
    expect(extras?.nationality).toBe('Malaysian');
    expect(
      getCollection('onboardingExtras' as CollectionName, CO).filter(
        (x) => (x as { employeeId: string }).employeeId === 'emp-1',
      ),
    ).toHaveLength(1);
  });
});
