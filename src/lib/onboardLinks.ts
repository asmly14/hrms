/**
 * Self-service onboarding links — shareable, token-gated new-hire intake.
 *
 * Owned by the OnboardingPortal module agent. Pure client-side:
 *
 *   Admin side   HR generates a link (label + optional position/department +
 *                expiry, default 14 days) and shares the URL via copy /
 *                WhatsApp / mailto. Submissions land back here for review;
 *                approving materializes an Employee record + onboarding
 *                extras + a lifecycle checklist.
 *   Public side  /onboard/:token is mounted OUTSIDE the auth guard. The
 *                applicant page resolves the link by token (cross-tenant
 *                scan of the global company directory), reads the company
 *                branding read-only, and submits a wizard form. No session,
 *                no active-tenant dependency.
 *
 * Storage note: db.ts `COLLECTIONS` is core-scaffold owned and cannot be
 * extended by this module, so the three collections below register their
 * keys via a typed cast — same `myhrms:t:<companyId>:` prefix, same pub/sub
 * semantics (identical pattern to lib/lifecycle.ts).
 *
 *   onboardLinks        → OnboardLink[]        (per company)
 *   onboardSubmissions  → OnboardSubmission[]  (per company)
 *   onboardingExtras    → OnboardingExtras[]   (per company, keyed by employeeId)
 *
 * `onboardingExtras` is the typed records-extension contract for the
 * employee-records module: academics, emergency contacts, address/nationality
 * and a document manifest hang off the employee WITHOUT touching the core
 * Employee type. Document bytes (base64 dataUrl) live ONLY on the submission
 * record — the extras manifest points back via submissionId so the records
 * module can hydrate previews without double-storing megabytes.
 */
import {
  getCollection,
  setCollection,
  getCompanies,
  getCompany,
  logAudit,
  nextEmployeeNo,
  uid,
  useCollection,
  type CollectionName,
} from './db';
import { buildOnboardingChecklist, type OnboardingChecklist } from './lifecycle';
import type {
  Company,
  Employee,
  EmploymentType,
  Gender,
  MaritalStatus,
  StateCode,
} from './types';

/* ────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────── */

export type OnboardLinkStatus = 'active' | 'submitted' | 'approved' | 'expired' | 'revoked';

export interface OnboardLink {
  id: string;
  /** Crypto-random URL-safe token — the secret that gates the public form. */
  token: string;
  companyId: string;
  /** Human label, typically the prospective hire's name. */
  label: string;
  positionId?: string;
  departmentId?: string;
  createdBy: string;
  createdAt: string; // ISO datetime
  expiresAt: string; // ISO datetime
  status: OnboardLinkStatus;
  /** Set when the applicant submits; kept pointing at the latest submission. */
  submissionId?: string;
}

export interface OnboardPersonal {
  name: string;
  ic: string; // normalized ######-##-####
  dob: string; // ISO date
  gender: Gender;
  maritalStatus: MaritalStatus;
  phone: string;
  email: string;
  address: string;
  state: StateCode;
  nationality: string;
  bankName: string;
  bankAccount: string;
  epfNo?: string;
  socsoNo?: string;
  taxNo?: string;
}

export interface EmergencyContact {
  name: string;
  relation: string;
  phone: string;
}

export type AcademicLevel =
  | 'SPM/STPM'
  | 'Certificate'
  | 'Diploma'
  | 'Degree'
  | 'Master'
  | 'PhD'
  | 'Other';

export interface AcademicEntry {
  level: AcademicLevel;
  institution: string;
  course: string;
  fromYear: string; // 'YYYY'
  toYear: string; // 'YYYY'
  grade?: string;
}

export type OnboardDocKind =
  | 'IC'
  | 'Academic Certificate'
  | 'CV'
  | 'Bank Statement'
  | 'Photo'
  | 'Other';

export interface OnboardDocument {
  kind: OnboardDocKind;
  fileName: string;
  /** base64 data URL — present on the submission record only (see header). */
  dataUrl?: string;
  sizeBytes: number;
  uploadedAt: string; // ISO datetime
}

export interface OnboardEmployment {
  positionId?: string;
  departmentId?: string;
  joinDate: string; // ISO date — expected first working day
  employmentType: EmploymentType;
}

export type OnboardReviewStatus = 'pending' | 'approved' | 'rejected';

export interface OnboardSubmission {
  id: string;
  linkId: string;
  companyId: string;
  submittedAt: string; // ISO datetime
  personal: OnboardPersonal;
  emergencyContacts: EmergencyContact[];
  academics: AcademicEntry[];
  employment: OnboardEmployment;
  documents: OnboardDocument[];
  declarationAccepted: boolean;
  // ── HR review workflow (absent until reviewed; 'pending' on submit) ──
  reviewStatus?: OnboardReviewStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNotes?: string;
  /** Employee record created on approval. */
  employeeId?: string;
}

/**
 * Records-module extension — everything the portal collected that does NOT
 * fit the core Employee type, keyed by employeeId. Read it back with
 * `getOnboardingExtras(employeeId)`; hydrate document bytes via
 * `getSubmission(extras.submissionId, extras.companyId)`.
 */
export interface OnboardingExtras {
  id: string; // == employeeId (one extras record per employee)
  employeeId: string;
  companyId: string;
  submissionId: string;
  address: string;
  homeState: StateCode;
  nationality: string;
  emergencyContacts: EmergencyContact[];
  academics: AcademicEntry[];
  /** Manifest only — no dataUrl here (bytes stay on the submission). */
  documents: Array<Pick<OnboardDocument, 'kind' | 'fileName' | 'sizeBytes' | 'uploadedAt'>>;
  declarationAccepted: boolean;
  attachedAt: string; // ISO datetime
}

/* ────────────────────────────────────────────────────────────
 * Constants
 * ──────────────────────────────────────────────────────────── */

export const ONBOARD_LINKS_KEY = 'onboardLinks';
export const ONBOARD_SUBMISSIONS_KEY = 'onboardSubmissions';
export const ONBOARDING_EXTRAS_KEY = 'onboardingExtras';

export const DEFAULT_EXPIRY_DAYS = 14;

/** Per-file upload cap — localStorage budgets ~5 MB per origin, and base64
 *  inflates bytes by ~4/3, so keep individual documents modest. */
export const MAX_FILE_BYTES = 700 * 1024; // 700 KB
export const MAX_FILE_LABEL = '700 KB';

export const REQUIRED_DOC_KINDS: OnboardDocKind[] = [
  'IC',
  'Academic Certificate',
  'CV',
  'Bank Statement',
  'Photo',
];

export const ACADEMIC_LEVELS: AcademicLevel[] = [
  'SPM/STPM',
  'Certificate',
  'Diploma',
  'Degree',
  'Master',
  'PhD',
  'Other',
];

export const ONBOARD_LINK_STATUS_LABELS: Record<OnboardLinkStatus, string> = {
  active: 'Active',
  submitted: 'Submitted',
  approved: 'Approved',
  expired: 'Expired',
  revoked: 'Revoked',
};

/* ────────────────────────────────────────────────────────────
 * Token & small pure helpers
 * ──────────────────────────────────────────────────────────── */

/**
 * Crypto-random URL-safe token: 18 bytes → 24 base64url characters
 * (~108 bits of entropy, safe to embed in a URL path segment).
 */
export function generateToken(): string {
  const bytes = new Uint8Array(18);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Normalize an NRIC to dashed form (######-##-####); non-12-digit input is returned trimmed. */
export function normalizeIc(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 12) return raw.trim();
  return `${digits.slice(0, 6)}-${digits.slice(6, 8)}-${digits.slice(8)}`;
}

/** Malaysian NRIC shape check (######-##-####). */
export function isValidIc(raw: string): boolean {
  return /^\d{6}-\d{2}-\d{4}$/.test(raw.trim());
}

/** True once the link's expiry instant has passed (independent of stored status). */
export function isLinkExpired(link: OnboardLink, now: Date = new Date()): boolean {
  const t = new Date(link.expiresAt).getTime();
  return Number.isFinite(t) && t <= now.getTime();
}

/** Stored status with time-based expiry applied — an active link past its
 *  expiresAt reads as 'expired' even before anything persists the change. */
export function effectiveLinkStatus(link: OnboardLink, now: Date = new Date()): OnboardLinkStatus {
  if (link.status === 'active' && isLinkExpired(link, now)) return 'expired';
  return link.status;
}

/**
 * Absolute share URL for a token. Vite's BASE_URL ('/', './', '/app/') is
 * normalized to an absolute path prefix so `${origin}<base>onboard/<token>`
 * always resolves to the SPA route the integration agent mounts publicly.
 */
export function buildOnboardUrl(token: string, origin?: string): string {
  let base = '/';
  try {
    base = import.meta.env?.BASE_URL ?? '/';
  } catch {
    base = '/';
  }
  let p = base.replace(/^\./, ''); // './' → '/', './app/' → '/app/'
  if (!p.startsWith('/')) p = `/${p}`;
  if (!p.endsWith('/')) p = `${p}/`;
  const o =
    origin ?? (typeof window !== 'undefined' && window.location ? window.location.origin : '');
  return `${o}${p}onboard/${token}`;
}

/** Friendly per-file size guard, enforced before the dataUrl is read. */
export function validateDocumentFile(fileName: string, sizeBytes: number): string | null {
  if (sizeBytes > MAX_FILE_BYTES) {
    const kb = Math.round(sizeBytes / 1024);
    return `"${fileName}" is ${kb.toLocaleString()} KB — the limit is ${MAX_FILE_LABEL} per file. Please compress it or choose a smaller file.`;
  }
  return null;
}

/* ────────────────────────────────────────────────────────────
 * Collection plumbing (typed-cast, tenant-scoped)
 * ──────────────────────────────────────────────────────────── */

const asCollection = (name: string) => name as CollectionName;

function updateLinkRecord(
  companyId: string,
  id: string,
  patch: Partial<OnboardLink>,
): OnboardLink | undefined {
  const next = getOnboardLinks(companyId).map((l) => (l.id === id ? { ...l, ...patch } : l));
  setCollection(asCollection(ONBOARD_LINKS_KEY), next, companyId);
  return next.find((l) => l.id === id);
}

function updateSubmissionRecord(
  companyId: string,
  id: string,
  patch: Partial<OnboardSubmission>,
): void {
  setCollection(
    asCollection(ONBOARD_SUBMISSIONS_KEY),
    getSubmissions(companyId).map((s) => (s.id === id ? { ...s, ...patch } : s)),
    companyId,
  );
}

/* ────────────────────────────────────────────────────────────
 * Link CRUD + audit
 * ──────────────────────────────────────────────────────────── */

export function getOnboardLinks(tenantId?: string): OnboardLink[] {
  return getCollection<OnboardLink>(asCollection(ONBOARD_LINKS_KEY), tenantId);
}

export function useOnboardLinks() {
  return useCollection<OnboardLink>(asCollection(ONBOARD_LINKS_KEY));
}

export interface CreateOnboardLinkInput {
  label: string;
  companyId: string;
  createdBy: string;
  positionId?: string;
  departmentId?: string;
  /** Days until expiry; defaults to DEFAULT_EXPIRY_DAYS (14). */
  expiryDays?: number;
  /** Test hook — deterministic createdAt/expiresAt. */
  now?: Date;
}

export function createOnboardLink(input: CreateOnboardLinkInput): OnboardLink {
  const now = input.now ?? new Date();
  const expires = new Date(now.getTime());
  expires.setDate(expires.getDate() + Math.max(1, input.expiryDays ?? DEFAULT_EXPIRY_DAYS));
  const link: OnboardLink = {
    id: uid(),
    token: generateToken(),
    companyId: input.companyId,
    label: input.label.trim(),
    positionId: input.positionId || undefined,
    departmentId: input.departmentId || undefined,
    createdBy: input.createdBy,
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    status: 'active',
  };
  setCollection(
    asCollection(ONBOARD_LINKS_KEY),
    [...getOnboardLinks(input.companyId), link],
    input.companyId,
  );
  logAudit(
    {
      actorName: input.createdBy,
      action: 'onboard.link.create',
      entity: ONBOARD_LINKS_KEY,
      entityId: link.id,
      detail: `Onboarding invite link created for "${link.label}" (expires ${link.expiresAt.slice(0, 10)})`,
    },
    input.companyId,
  );
  return link;
}

export function revokeOnboardLink(link: OnboardLink, actorName: string): void {
  updateLinkRecord(link.companyId, link.id, { status: 'revoked' });
  logAudit(
    {
      actorName,
      action: 'onboard.link.revoke',
      entity: ONBOARD_LINKS_KEY,
      entityId: link.id,
      detail: `Onboarding invite link for "${link.label}" revoked`,
    },
    link.companyId,
  );
}

/** Persist time-based expiry transitions so the admin table tells the truth. */
export function sweepExpiredLinks(tenantId?: string, now: Date = new Date()): void {
  const all = getOnboardLinks(tenantId);
  if (!all.some((l) => l.status === 'active' && isLinkExpired(l, now))) return;
  const co = all[0]?.companyId ?? tenantId;
  setCollection(
    asCollection(ONBOARD_LINKS_KEY),
    all.map((l) => (l.status === 'active' && isLinkExpired(l, now) ? { ...l, status: 'expired' as const } : l)),
    co,
  );
}

/* ────────────────────────────────────────────────────────────
 * Public token resolution (no session, no active tenant)
 * ──────────────────────────────────────────────────────────── */

/** Cross-tenant lookup: a token is globally unique, so scan every company's
 *  link collection via the global tenant directory. */
export function findLinkByToken(
  token: string,
): { link: OnboardLink; companyId: string } | undefined {
  for (const c of getCompanies()) {
    const hit = getOnboardLinks(c.id).find((l) => l.token === token);
    if (hit) return { link: hit, companyId: c.id };
  }
  return undefined;
}

export type PublicLinkReason =
  | 'ok'
  | 'not-found'
  | 'revoked'
  | 'expired'
  | 'submitted'
  | 'approved';

export interface ResolvedPublicLink {
  reason: PublicLinkReason;
  link?: OnboardLink;
  company?: Company;
  /** Latest rejected submission, when the applicant may correct & resubmit. */
  resubmission?: OnboardSubmission;
}

/**
 * Resolve a public token to its render state. Past-expiry active links are
 * transitioned to 'expired' in storage as a side effect (truthful admin table).
 * A rejected submission re-opens the link (see rejectSubmission) and is
 * returned so the form can prefill.
 */
export function resolvePublicLink(token: string, now: Date = new Date()): ResolvedPublicLink {
  const found = findLinkByToken(token);
  if (!found) return { reason: 'not-found' };
  const { link, companyId } = found;
  const company = getCompany(companyId);

  if (link.status === 'revoked') return { reason: 'revoked', link, company };
  if (link.status === 'approved') return { reason: 'approved', link, company };
  if (link.status === 'submitted') return { reason: 'submitted', link, company };
  if (isLinkExpired(link, now)) {
    const updated = updateLinkRecord(companyId, link.id, { status: 'expired' });
    return { reason: 'expired', link: updated ?? { ...link, status: 'expired' }, company };
  }
  const latest = latestSubmissionForLink(link.id, companyId);
  const resubmission = latest?.reviewStatus === 'rejected' ? latest : undefined;
  return { reason: 'ok', link, company, resubmission };
}

/* ────────────────────────────────────────────────────────────
 * Submissions
 * ──────────────────────────────────────────────────────────── */

export function getSubmissions(tenantId?: string): OnboardSubmission[] {
  return getCollection<OnboardSubmission>(asCollection(ONBOARD_SUBMISSIONS_KEY), tenantId);
}

export function useOnboardSubmissions() {
  return useCollection<OnboardSubmission>(asCollection(ONBOARD_SUBMISSIONS_KEY));
}

export function getSubmission(id: string, tenantId?: string): OnboardSubmission | undefined {
  return getSubmissions(tenantId).find((s) => s.id === id);
}

/** Most recent submission for a link (resubmissions after rejection create new records). */
export function latestSubmissionForLink(
  linkId: string,
  tenantId?: string,
): OnboardSubmission | undefined {
  const list = getSubmissions(tenantId).filter((s) => s.linkId === linkId);
  return list.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
}

export function markSubmitted(link: OnboardLink, submissionId: string): void {
  updateLinkRecord(link.companyId, link.id, { status: 'submitted', submissionId });
}

/** What the applicant posts — everything except server-assigned fields. */
export type OnboardDraft = Omit<
  OnboardSubmission,
  'id' | 'linkId' | 'companyId' | 'submittedAt' | 'reviewStatus'
>;

export type SubmitResult =
  | { ok: true; submission: OnboardSubmission }
  | { ok: false; error: string };

/**
 * Persist an applicant submission and flip the link to 'submitted'.
 * Quota failures (document dataUrls vs the ~5 MB localStorage budget) surface
 * as a friendly error instead of a thrown exception.
 */
export function submitOnboardForm(link: OnboardLink, draft: OnboardDraft): SubmitResult {
  const submission: OnboardSubmission = {
    ...draft,
    id: uid(),
    linkId: link.id,
    companyId: link.companyId,
    submittedAt: new Date().toISOString(),
    reviewStatus: 'pending',
  };
  try {
    setCollection(
      asCollection(ONBOARD_SUBMISSIONS_KEY),
      [...getSubmissions(link.companyId), submission],
      link.companyId,
    );
    markSubmitted(link, submission.id);
  } catch {
    return {
      ok: false,
      error:
        'Your submission could not be saved — the uploaded files are too large for this browser. Please compress the documents and try again, or contact HR for assistance.',
    };
  }
  logAudit(
    {
      actorName: 'Self-service applicant',
      action: 'onboard.submit',
      entity: ONBOARD_SUBMISSIONS_KEY,
      entityId: submission.id,
      detail: `Onboarding form submitted by ${submission.personal.name} via link "${link.label}"`,
    },
    link.companyId,
  );
  return { ok: true, submission };
}

/* ────────────────────────────────────────────────────────────
 * Records extension (extras keyed by employeeId)
 * ──────────────────────────────────────────────────────────── */

export function getOnboardingExtras(employeeId: string, tenantId?: string): OnboardingExtras | undefined {
  return getCollection<OnboardingExtras>(asCollection(ONBOARDING_EXTRAS_KEY), tenantId).find(
    (x) => x.employeeId === employeeId,
  );
}

/**
 * Attach everything the portal collected that the core Employee type cannot
 * hold, keyed by employeeId, for the employee-records module to render.
 * Document bytes are NOT copied — the manifest points back to the submission.
 */
export function attachOnboardingExtras(
  employeeId: string,
  submission: OnboardSubmission,
  tenantId?: string,
): OnboardingExtras {
  const co = tenantId ?? submission.companyId;
  const extras: OnboardingExtras = {
    id: employeeId,
    employeeId,
    companyId: co,
    submissionId: submission.id,
    address: submission.personal.address,
    homeState: submission.personal.state,
    nationality: submission.personal.nationality,
    emergencyContacts: submission.emergencyContacts,
    academics: submission.academics,
    documents: submission.documents.map(({ kind, fileName, sizeBytes, uploadedAt }) => ({
      kind,
      fileName,
      sizeBytes,
      uploadedAt,
    })),
    declarationAccepted: submission.declarationAccepted,
    attachedAt: new Date().toISOString(),
  };
  const rest = getCollection<OnboardingExtras>(asCollection(ONBOARDING_EXTRAS_KEY), co).filter(
    (x) => x.employeeId !== employeeId,
  );
  setCollection(asCollection(ONBOARDING_EXTRAS_KEY), [...rest, extras], co);
  return extras;
}

/* ────────────────────────────────────────────────────────────
 * Approval → Employee mapping
 * ──────────────────────────────────────────────────────────── */

export interface ApproveOverrides {
  /** RM monthly — the one mandatory field the portal does not collect. */
  baseSalary: number;
  positionId: string;
  departmentId: string;
  joinDate: string; // ISO date
  employmentType: EmploymentType;
  /** Work-location state; defaults to the applicant's address state. */
  state?: StateCode;
  /** HR reviewer name (audit + review trail). */
  reviewer: string;
  /** Optional review note stored on the submission. */
  notes?: string;
}

/**
 * Map a submission onto a persistable Employee (without id). Statutory
 * numbers the applicant skipped stay blank; children default to 0; status
 * starts at 'probation' (mirrors the employee module's new-hire wizard).
 */
export function buildEmployeeFromSubmission(
  submission: OnboardSubmission,
  overrides: ApproveOverrides,
): Omit<Employee, 'id'> {
  const p = submission.personal;
  const nationality = p.nationality.trim();
  return {
    employeeNo: nextEmployeeNo(submission.companyId),
    name: p.name.trim(),
    ic: normalizeIc(p.ic),
    email: p.email.trim().toLowerCase(),
    phone: p.phone.trim(),
    departmentId: overrides.departmentId,
    positionId: overrides.positionId,
    role: 'employee',
    joinDate: overrides.joinDate,
    state: overrides.state ?? p.state,
    employmentType: overrides.employmentType,
    status: 'probation',
    baseSalary: Math.round(overrides.baseSalary * 100) / 100,
    maritalStatus: p.maritalStatus,
    children: 0,
    bankName: p.bankName.trim(),
    bankAccount: p.bankAccount.trim(),
    epfNo: p.epfNo?.trim() ?? '',
    socsoNo: p.socsoNo?.trim() ?? '',
    taxNo: p.taxNo?.trim() ?? '',
    isForeignWorker: nationality !== '' && !/malaysia/i.test(nationality),
    dateOfBirth: p.dob,
    gender: p.gender,
    fixedAllowances: [],
  };
}

/** Create the lifecycle onboarding checklist for a freshly approved hire.
 *  Writes the same typed-cast key useOnboardingChecklists() reads. */
export function createChecklistForEmployee(
  employeeId: string,
  joinDate: string,
  employmentType: EmploymentType,
  tenantId?: string,
): void {
  const templateKey = employmentType === 'contract' ? 'contract' : 'standard';
  const payload = buildOnboardingChecklist(employeeId, templateKey, joinDate);
  const key = asCollection('onboardingChecklists');
  const record: OnboardingChecklist = { ...payload, id: uid() };
  setCollection(key, [...getCollection<OnboardingChecklist>(key, tenantId), record], tenantId);
}

export type ApproveResult =
  | { ok: true; employee: Employee; extras: OnboardingExtras }
  | { ok: false; error: string };

/**
 * Approve a submission end-to-end:
 *   1. materialize the Employee record (with a company employeeNo)
 *   2. attach the onboarding extras (records-module extension)
 *   3. seed the onboarding checklist (standard / contract template)
 *   4. mark the submission approved + the link approved
 *   5. audit the action
 */
export function approveSubmission(
  submission: OnboardSubmission,
  overrides: ApproveOverrides,
): ApproveResult {
  if (!overrides.joinDate) return { ok: false, error: 'Join date is required.' };
  if (!Number.isFinite(overrides.baseSalary) || overrides.baseSalary <= 0) {
    return { ok: false, error: 'Base salary must be greater than zero.' };
  }
  if (!overrides.departmentId) return { ok: false, error: 'Select a department.' };
  if (!overrides.positionId) return { ok: false, error: 'Select a position.' };

  const co = submission.companyId;
  const employee: Employee = { id: uid(), ...buildEmployeeFromSubmission(submission, overrides) };
  let extras: OnboardingExtras;
  try {
    setCollection('employees', [...getCollection<Employee>('employees', co), employee], co);
    extras = attachOnboardingExtras(employee.id, submission, co);
    createChecklistForEmployee(employee.id, employee.joinDate, employee.employmentType, co);
    updateSubmissionRecord(co, submission.id, {
      reviewStatus: 'approved',
      reviewedBy: overrides.reviewer,
      reviewedAt: new Date().toISOString(),
      reviewNotes: overrides.notes?.trim() || undefined,
      employeeId: employee.id,
    });
    const link = getOnboardLinks(co).find((l) => l.id === submission.linkId);
    if (link) updateLinkRecord(co, link.id, { status: 'approved', submissionId: submission.id });
  } catch {
    return {
      ok: false,
      error: 'Approval could not be saved (browser storage is full). Try removing old data first.',
    };
  }
  logAudit(
    {
      actorName: overrides.reviewer,
      action: 'onboard.approve',
      entity: ONBOARD_SUBMISSIONS_KEY,
      entityId: submission.id,
      detail: `Submission approved — ${employee.name} created as ${employee.employeeNo ?? employee.id}`,
    },
    co,
  );
  return { ok: true, employee, extras };
}

/**
 * Reject a submission with a reason. The link re-opens (status 'active') so
 * the applicant can correct and resubmit; the rejection trail stays on the
 * submission record and is prefilled on the next visit.
 */
export function rejectSubmission(submission: OnboardSubmission, reason: string, reviewer: string): void {
  const co = submission.companyId;
  updateSubmissionRecord(co, submission.id, {
    reviewStatus: 'rejected',
    reviewedBy: reviewer,
    reviewedAt: new Date().toISOString(),
    reviewNotes: reason.trim(),
  });
  const link = getOnboardLinks(co).find((l) => l.id === submission.linkId);
  if (link && link.status === 'submitted') {
    updateLinkRecord(co, link.id, { status: 'active', submissionId: undefined });
  }
  logAudit(
    {
      actorName: reviewer,
      action: 'onboard.reject',
      entity: ONBOARD_SUBMISSIONS_KEY,
      entityId: submission.id,
      detail: `Submission from ${submission.personal.name} rejected: ${reason.trim()}`,
    },
    co,
  );
}
