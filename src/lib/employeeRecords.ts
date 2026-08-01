/**
 * Employee record-keeping engine — the full personnel file.
 *
 * Owned by the EmployeeRecords module agent. Malaysian Employment Act 1955
 * s.61 register spirit: every employee carries a complete file — dependents,
 * emergency contacts, academics, employment history, document repository,
 * salary history, discipline, company assets and notes.
 *
 * Storage note: db.ts `COLLECTIONS` is core-scaffold owned and cannot be
 * extended by this module, so the `employeeRecords` collection registers its
 * key via a typed cast — same `myhrms:t:<companyId>:` tenant prefix, same
 * reactive `useCollection` semantics (pattern mirrors lib/lifecycle.ts).
 *
 * One EmployeeRecordFile per employeeId, created on demand; every mutation
 * writes an audit entry.
 */
import { getCollection, logAudit, setCollection, uid, useCollection, type CollectionName } from './db';
import { round2 } from './utils';
import type { Employee } from './types';

/* ────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────── */

/** Dependent / family member. `isChild` drives the PCB child-relief count hint. */
export interface Dependent {
  id: string;
  name: string;
  relation: string; // spouse / child / parent / sibling / other
  dob?: string; // ISO date
  ic?: string;
  isChild: boolean;
  occupation?: string;
}

export interface EmergencyContact {
  id: string;
  name: string;
  relation: string;
  phone: string;
}

export interface AcademicRecord {
  id: string;
  level: string; // SPM / STPM / Diploma / Degree / Masters / PhD / Certificate
  institution: string;
  course: string;
  fromYear: number;
  toYear: number;
  grade?: string;
}

export interface PreviousEmployment {
  id: string;
  company: string;
  role: string;
  from: string; // ISO date
  to: string; // ISO date
  reasonForLeaving?: string;
}

export type DocumentKind =
  | 'IC'
  | 'Passport'
  | 'Work Permit'
  | 'Academic Certificate'
  | 'CV'
  | 'Bank Statement'
  | 'Medical'
  | 'Contract'
  | 'Other';

export const DOCUMENT_KINDS: DocumentKind[] = [
  'IC',
  'Passport',
  'Work Permit',
  'Academic Certificate',
  'CV',
  'Bank Statement',
  'Medical',
  'Contract',
  'Other',
];

/** Kinds whose expiry date matters for compliance alerts. */
export const EXPIRY_TRACKED_KINDS: DocumentKind[] = ['Passport', 'Work Permit', 'Medical'];

export interface RecordDocument {
  id: string;
  kind: DocumentKind;
  fileName: string;
  /** Inlined file payload (≤ MAX_DOCUMENT_BYTES). Optional for metadata-only entries. */
  dataUrl?: string;
  sizeBytes: number;
  issueDate?: string; // ISO date
  expiryDate?: string; // ISO date
  uploadedAt: string; // ISO datetime
}

export type SalaryChangeReason =
  | 'annual-increment'
  | 'promotion'
  | 'adjustment'
  | 'probation-confirmation';

export const SALARY_CHANGE_REASON_LABELS: Record<SalaryChangeReason, string> = {
  'annual-increment': 'Annual increment',
  promotion: 'Promotion',
  adjustment: 'Adjustment',
  'probation-confirmation': 'Probation confirmation',
};

export interface SalaryChange {
  id: string;
  effectiveDate: string; // ISO date
  previousSalary: number; // RM monthly
  newSalary: number; // RM monthly
  changePercent: number; // derived, 2dp
  reason: SalaryChangeReason;
  approvedBy?: string;
  note?: string;
}

export type DisciplineType =
  | 'verbal-warning'
  | 'written-warning'
  | 'show-cause'
  | 'suspension'
  | 'other';

export const DISCIPLINE_TYPE_LABELS: Record<DisciplineType, string> = {
  'verbal-warning': 'Verbal warning',
  'written-warning': 'Written warning',
  'show-cause': 'Show cause letter',
  suspension: 'Suspension',
  other: 'Other',
};

export interface DisciplineRecord {
  id: string;
  date: string; // ISO date
  type: DisciplineType;
  subject: string;
  detail: string;
  issuedBy: string;
  /** ISO datetime when the employee acknowledged receipt. */
  acknowledgedAt?: string;
}

export interface AssetRecord {
  id: string;
  item: string;
  serialNo?: string;
  issuedAt: string; // ISO date
  condition: string; // e.g. 'New', 'Good', 'Fair'
  /** Set when returned — feeds the offboarding clearance checklist idea. */
  returnedAt?: string; // ISO date
}

export interface RecordNote {
  id: string;
  date: string; // ISO date
  author: string;
  text: string;
}

/**
 * The full personnel file for one employee. All sections default to empty
 * arrays so older stored files keep working as sections are added.
 */
export interface EmployeeRecordFile {
  id: string;
  employeeId: string;
  dependents: Dependent[];
  emergencyContacts: EmergencyContact[];
  academics: AcademicRecord[];
  previousEmployment: PreviousEmployment[];
  documents: RecordDocument[];
  salaryHistory: SalaryChange[];
  discipline: DisciplineRecord[];
  assets: AssetRecord[];
  notes: RecordNote[];
  createdAt: string; // ISO datetime
  updatedAt: string; // ISO datetime
}

/* ────────────────────────────────────────────────────────────
 * Constants & small helpers
 * ──────────────────────────────────────────────────────────── */

/** Upload cap per document (localStorage is finite). */
export const MAX_DOCUMENT_BYTES = 700 * 1024; // 700 KB

/** Documents expiring within this many days raise an amber alert. */
export const EXPIRY_ALERT_DAYS = 90;

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

export function todayISO(): string {
  return toISODate(new Date());
}

function parseDate(iso: string): Date {
  return new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
}

/** KB/MB display for document sizes. */
export function fmtFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Whole days from today (or `asOf`) to an ISO date. Negative = past. */
export function daysUntil(iso: string, asOf: string = todayISO()): number {
  return Math.round((parseDate(iso).getTime() - parseDate(asOf).getTime()) / 86_400_000);
}

/* ────────────────────────────────────────────────────────────
 * Reactive store — db.ts pub/sub on a module-owned key
 * ──────────────────────────────────────────────────────────── */

export const EMPLOYEE_RECORDS_COLLECTION = 'employeeRecords';

const asCollection = (name: string) => name as CollectionName;
const col = () => asCollection(EMPLOYEE_RECORDS_COLLECTION);

export function useEmployeeRecordFiles() {
  return useCollection<EmployeeRecordFile>(col());
}

/** Non-reactive read of one employee's file (undefined until created). */
export function getRecordFile(employeeId: string): EmployeeRecordFile | undefined {
  return getCollection<EmployeeRecordFile>(col()).find((f) => f.employeeId === employeeId);
}

export function emptyRecordFile(employeeId: string): Omit<EmployeeRecordFile, 'id'> {
  const now = new Date().toISOString();
  return {
    employeeId,
    dependents: [],
    emergencyContacts: [],
    academics: [],
    previousEmployment: [],
    documents: [],
    salaryHistory: [],
    discipline: [],
    assets: [],
    notes: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Normalize a stored file so sections added later never come back undefined. */
function normalize(file: EmployeeRecordFile): EmployeeRecordFile {
  return {
    ...file,
    dependents: file.dependents ?? [],
    emergencyContacts: file.emergencyContacts ?? [],
    academics: file.academics ?? [],
    previousEmployment: file.previousEmployment ?? [],
    documents: file.documents ?? [],
    salaryHistory: file.salaryHistory ?? [],
    discipline: file.discipline ?? [],
    assets: file.assets ?? [],
    notes: file.notes ?? [],
  };
}

/* ────────────────────────────────────────────────────────────
 * Mutation core — one file per employee, created on demand,
 * every change audited.
 * ──────────────────────────────────────────────────────────── */

function auditRecords(
  action: string,
  employeeId: string,
  detail: string,
  actorName: string,
): void {
  logAudit({ actorName, action, entity: EMPLOYEE_RECORDS_COLLECTION, entityId: employeeId, detail });
}

/**
 * Apply `mutate` to the employee's file, creating it on first touch.
 * Audits both the implicit creation (once) and the mutation itself.
 */
export function mutateRecordFile(
  employeeId: string,
  mutate: (file: EmployeeRecordFile) => EmployeeRecordFile,
  audit: { action: string; detail: string; actorName: string },
): EmployeeRecordFile {
  const all = getCollection<EmployeeRecordFile>(col());
  const existing = all.find((f) => f.employeeId === employeeId);
  let next: EmployeeRecordFile[];
  let base: EmployeeRecordFile;
  if (existing) {
    base = normalize(existing);
    next = all.map((f) => (f.employeeId === employeeId ? { ...mutate(base), updatedAt: new Date().toISOString() } : f));
  } else {
    base = { ...emptyRecordFile(employeeId), id: uid() };
    const created = { ...mutate(base), updatedAt: new Date().toISOString() };
    next = [...all, created];
    auditRecords('records.file.create', employeeId, 'Personnel file created', audit.actorName);
  }
  setCollection(col(), next);
  auditRecords(audit.action, employeeId, audit.detail, audit.actorName);
  return next.find((f) => f.employeeId === employeeId)!;
}

/* ────────────────────────────────────────────────────────────
 * Section mutators (named CRUD wrappers over the core)
 * ──────────────────────────────────────────────────────────── */

type ArraySectionKey =
  | 'dependents'
  | 'emergencyContacts'
  | 'academics'
  | 'previousEmployment'
  | 'documents'
  | 'salaryHistory'
  | 'discipline'
  | 'assets'
  | 'notes';

function upsertItem<K extends ArraySectionKey>(
  employeeId: string,
  section: K,
  item: Omit<EmployeeRecordFile[K][number], 'id'> & { id?: string },
  audit: { action: string; detail: string; actorName: string },
): void {
  mutateRecordFile(
    employeeId,
    (file) => {
      const list = file[section] as { id: string }[];
      const id = item.id ?? uid();
      const exists = list.some((x) => x.id === id);
      const nextList = exists
        ? list.map((x) => (x.id === id ? { ...item, id } : x))
        : [...list, { ...item, id }];
      return { ...file, [section]: nextList } as EmployeeRecordFile;
    },
    audit,
  );
}

function removeItem<K extends ArraySectionKey>(
  employeeId: string,
  section: K,
  itemId: string,
  audit: { action: string; detail: string; actorName: string },
): void {
  mutateRecordFile(
    employeeId,
    (file) => {
      const list = file[section] as { id: string }[];
      return { ...file, [section]: list.filter((x) => x.id !== itemId) } as EmployeeRecordFile;
    },
    audit,
  );
}

// Dependents
export const saveDependent = (employeeId: string, dep: Omit<Dependent, 'id'> & { id?: string }, actor: string) =>
  upsertItem(employeeId, 'dependents', dep, { action: 'records.dependent.save', detail: `Dependent ${dep.name} (${dep.relation})`, actorName: actor });
export const removeDependent = (employeeId: string, id: string, name: string, actor: string) =>
  removeItem(employeeId, 'dependents', id, { action: 'records.dependent.remove', detail: `Removed dependent ${name}`, actorName: actor });

// Emergency contacts
export const saveEmergencyContact = (employeeId: string, c: Omit<EmergencyContact, 'id'> & { id?: string }, actor: string) =>
  upsertItem(employeeId, 'emergencyContacts', c, { action: 'records.emergency.save', detail: `Emergency contact ${c.name} (${c.relation})`, actorName: actor });
export const removeEmergencyContact = (employeeId: string, id: string, name: string, actor: string) =>
  removeItem(employeeId, 'emergencyContacts', id, { action: 'records.emergency.remove', detail: `Removed emergency contact ${name}`, actorName: actor });

// Academics
export const saveAcademic = (employeeId: string, a: Omit<AcademicRecord, 'id'> & { id?: string }, actor: string) =>
  upsertItem(employeeId, 'academics', a, { action: 'records.academic.save', detail: `${a.level} — ${a.institution}`, actorName: actor });
export const removeAcademic = (employeeId: string, id: string, label: string, actor: string) =>
  removeItem(employeeId, 'academics', id, { action: 'records.academic.remove', detail: `Removed ${label}`, actorName: actor });

// Previous employment
export const savePreviousEmployment = (employeeId: string, p: Omit<PreviousEmployment, 'id'> & { id?: string }, actor: string) =>
  upsertItem(employeeId, 'previousEmployment', p, { action: 'records.employment.save', detail: `${p.role} @ ${p.company}`, actorName: actor });
export const removePreviousEmployment = (employeeId: string, id: string, label: string, actor: string) =>
  removeItem(employeeId, 'previousEmployment', id, { action: 'records.employment.remove', detail: `Removed ${label}`, actorName: actor });

// Documents
export function saveDocument(
  employeeId: string,
  doc: Omit<RecordDocument, 'id' | 'uploadedAt'> & { id?: string; uploadedAt?: string },
  actor: string,
): void {
  if (doc.sizeBytes > MAX_DOCUMENT_BYTES) {
    throw new Error(
      `File exceeds the ${Math.round(MAX_DOCUMENT_BYTES / 1024)} KB limit (${(doc.sizeBytes / 1024).toFixed(0)} KB).`,
    );
  }
  upsertItem(
    employeeId,
    'documents',
    { ...doc, uploadedAt: doc.uploadedAt ?? new Date().toISOString() },
    { action: 'records.document.save', detail: `${doc.kind}: ${doc.fileName}`, actorName: actor },
  );
}
export const removeDocument = (employeeId: string, id: string, fileName: string, actor: string) =>
  removeItem(employeeId, 'documents', id, { action: 'records.document.remove', detail: `Removed ${fileName}`, actorName: actor });

// Discipline
export const saveDiscipline = (employeeId: string, d: Omit<DisciplineRecord, 'id'> & { id?: string }, actor: string) =>
  upsertItem(employeeId, 'discipline', d, { action: 'records.discipline.save', detail: `${DISCIPLINE_TYPE_LABELS[d.type]} — ${d.subject}`, actorName: actor });
export const removeDiscipline = (employeeId: string, id: string, subject: string, actor: string) =>
  removeItem(employeeId, 'discipline', id, { action: 'records.discipline.remove', detail: `Removed ${subject}`, actorName: actor });

/** Employee acknowledgement flow — stamps the record with a datetime. */
export function acknowledgeDiscipline(employeeId: string, id: string, actor: string): void {
  mutateRecordFile(
    employeeId,
    (file) => ({
      ...file,
      discipline: file.discipline.map((d) =>
        d.id === id ? { ...d, acknowledgedAt: new Date().toISOString() } : d,
      ),
    }),
    { action: 'records.discipline.acknowledge', detail: 'Disciplinary record acknowledged', actorName: actor },
  );
}

// Assets
export const saveAsset = (employeeId: string, a: Omit<AssetRecord, 'id'> & { id?: string }, actor: string) =>
  upsertItem(employeeId, 'assets', a, { action: 'records.asset.save', detail: `Issued ${a.item}`, actorName: actor });
export const removeAsset = (employeeId: string, id: string, item: string, actor: string) =>
  removeItem(employeeId, 'assets', id, { action: 'records.asset.remove', detail: `Removed ${item}`, actorName: actor });

/** Mark an asset returned — pairs with the offboarding clearance checklist. */
export function returnAsset(employeeId: string, id: string, item: string, actor: string, returnedAt: string = todayISO()): void {
  mutateRecordFile(
    employeeId,
    (file) => ({
      ...file,
      assets: file.assets.map((a) => (a.id === id ? { ...a, returnedAt } : a)),
    }),
    { action: 'records.asset.return', detail: `Returned ${item}`, actorName: actor },
  );
}

// Notes
export const addNote = (employeeId: string, note: Omit<RecordNote, 'id'>, actor: string) =>
  upsertItem(employeeId, 'notes', note, { action: 'records.note.add', detail: note.text.slice(0, 80), actorName: actor });
export const removeNote = (employeeId: string, id: string, actor: string) =>
  removeItem(employeeId, 'notes', id, { action: 'records.note.remove', detail: 'Removed note', actorName: actor });

/* ────────────────────────────────────────────────────────────
 * Salary history
 * ──────────────────────────────────────────────────────────── */

/** % change between two monthly salaries, 2dp. Zero/negative base → 0. */
export function salaryChangePercent(previousSalary: number, newSalary: number): number {
  if (!Number.isFinite(previousSalary) || !Number.isFinite(newSalary) || previousSalary <= 0) return 0;
  return round2(((newSalary - previousSalary) / previousSalary) * 100);
}

/**
 * Build a SalaryChange entry, auto-filling previousSalary from the employee's
 * current baseSalary and deriving changePercent.
 */
export function buildSalaryChange(
  employee: Employee,
  input: {
    effectiveDate: string;
    newSalary: number;
    reason: SalaryChangeReason;
    approvedBy?: string;
    note?: string;
  },
): Omit<SalaryChange, 'id'> {
  const previousSalary = round2(employee.baseSalary);
  const newSalary = round2(input.newSalary);
  return {
    effectiveDate: input.effectiveDate,
    previousSalary,
    newSalary,
    changePercent: salaryChangePercent(previousSalary, newSalary),
    reason: input.reason,
    approvedBy: input.approvedBy?.trim() || undefined,
    note: input.note?.trim() || undefined,
  };
}

/**
 * Append a salary change to the file; optionally update the employee's live
 * baseSalary in the employees collection (the payroll driver). Audits both.
 */
export function recordSalaryChange(
  employee: Employee,
  input: {
    effectiveDate: string;
    newSalary: number;
    reason: SalaryChangeReason;
    approvedBy?: string;
    note?: string;
    /** When true, employee.baseSalary is updated to newSalary. */
    applyToBaseSalary: boolean;
  },
  actor: string,
): Omit<SalaryChange, 'id'> {
  const change = buildSalaryChange(employee, input);
  upsertItem(employee.id, 'salaryHistory', change, {
    action: 'records.salary.record',
    detail: `${SALARY_CHANGE_REASON_LABELS[change.reason]}: RM ${change.previousSalary.toFixed(2)} → RM ${change.newSalary.toFixed(2)} (${change.changePercent >= 0 ? '+' : ''}${change.changePercent}%)`,
    actorName: actor,
  });
  if (input.applyToBaseSalary && change.newSalary !== employee.baseSalary) {
    const employees = getCollection<Employee>('employees');
    setCollection(
      'employees',
      employees.map((e) => (e.id === employee.id ? { ...e, baseSalary: change.newSalary } : e)),
    );
    logAudit({
      actorName: actor,
      action: 'employee.update',
      entity: 'employees',
      entityId: employee.id,
      detail: `Base salary updated to RM ${change.newSalary.toFixed(2)} via records (${SALARY_CHANGE_REASON_LABELS[change.reason]}, effective ${change.effectiveDate})`,
    });
  }
  return change;
}

/* ────────────────────────────────────────────────────────────
 * Completeness — the EA s.61 register health check
 * ──────────────────────────────────────────────────────────── */

export interface CompletenessItem {
  key: string;
  label: string;
  ok: boolean;
  /** UI section the missing-item chip should link to. */
  section: 'core' | 'emergency' | 'academics' | 'documents';
}

export interface RecordCompleteness {
  percent: number;
  missing: string[];
  items: CompletenessItem[];
}

/**
 * Score how complete an employee's personnel file is. Checks core Employee
 * fields (IC, DOB, phone, work-location address, bank, EPF/SOCSO/tax numbers)
 * plus file sections (≥1 emergency contact, ≥1 academic record, IC document
 * uploaded). Note: the core Employee type carries no street-address field, so
 * "address" is proxied by the work-location state.
 */
export function recordCompleteness(
  employee: Employee,
  file: EmployeeRecordFile | undefined,
): RecordCompleteness {
  const items: CompletenessItem[] = [
    { key: 'ic', label: 'NRIC / passport no.', ok: !!employee.ic?.trim(), section: 'core' },
    { key: 'dob', label: 'Date of birth', ok: !!employee.dateOfBirth?.trim(), section: 'core' },
    { key: 'phone', label: 'Phone number', ok: !!employee.phone?.trim(), section: 'core' },
    { key: 'address', label: 'Address / work location', ok: !!employee.state?.trim(), section: 'core' },
    {
      key: 'bank',
      label: 'Bank account (salary credit)',
      ok: !!employee.bankName?.trim() && !!employee.bankAccount?.trim(),
      section: 'core',
    },
    { key: 'epf', label: 'EPF / KWSP number', ok: !!employee.epfNo?.trim(), section: 'core' },
    { key: 'socso', label: 'SOCSO number', ok: !!employee.socsoNo?.trim(), section: 'core' },
    { key: 'tax', label: 'Income tax number', ok: !!employee.taxNo?.trim(), section: 'core' },
    {
      key: 'emergency',
      label: 'Emergency contact',
      ok: (file?.emergencyContacts?.length ?? 0) >= 1,
      section: 'emergency',
    },
    {
      key: 'academics',
      label: 'Academic qualification',
      ok: (file?.academics?.length ?? 0) >= 1,
      section: 'academics',
    },
    {
      key: 'ic-doc',
      label: 'IC document uploaded',
      ok: (file?.documents ?? []).some((d) => d.kind === 'IC'),
      section: 'documents',
    },
  ];
  const done = items.filter((i) => i.ok).length;
  return {
    percent: Math.round((done / items.length) * 100),
    missing: items.filter((i) => !i.ok).map((i) => i.label),
    items,
  };
}

/* ────────────────────────────────────────────────────────────
 * Document expiry tracking
 * ──────────────────────────────────────────────────────────── */

export type DocumentExpiryStatus = 'none' | 'valid' | 'expiring' | 'expired';

export interface DocumentExpiry {
  status: DocumentExpiryStatus;
  /** Days until expiry; negative when already expired; null when no expiryDate. */
  daysToExpiry: number | null;
}

/**
 * Expiry status of one document: 'expired' (< 0 days), 'expiring'
 * (≤ alertDays), 'valid' (> alertDays), 'none' (no expiry date recorded).
 */
export function documentExpiryStatus(
  doc: Pick<RecordDocument, 'expiryDate'>,
  asOf: string = todayISO(),
  alertDays: number = EXPIRY_ALERT_DAYS,
): DocumentExpiry {
  if (!doc.expiryDate) return { status: 'none', daysToExpiry: null };
  const daysToExpiry = daysUntil(doc.expiryDate, asOf);
  if (daysToExpiry < 0) return { status: 'expired', daysToExpiry };
  if (daysToExpiry <= alertDays) return { status: 'expiring', daysToExpiry };
  return { status: 'valid', daysToExpiry };
}

export interface ExpiringDocument {
  employeeId: string;
  document: RecordDocument;
  status: 'expiring' | 'expired';
  daysToExpiry: number;
}

/**
 * All documents across files that are expired or expiring within `days`,
 * soonest first. Drives the page alert banner and the dashboard hook.
 */
export function expiringDocuments(
  files: EmployeeRecordFile[],
  days: number = EXPIRY_ALERT_DAYS,
  asOf: string = todayISO(),
): ExpiringDocument[] {
  const out: ExpiringDocument[] = [];
  for (const file of files) {
    for (const document of file.documents ?? []) {
      const ex = documentExpiryStatus(document, asOf, days);
      if (ex.status === 'expiring' || ex.status === 'expired') {
        out.push({
          employeeId: file.employeeId,
          document,
          status: ex.status,
          daysToExpiry: ex.daysToExpiry ?? 0,
        });
      }
    }
  }
  return out.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
}

export interface ExpiringDocumentWithEmployee extends ExpiringDocument {
  employeeName: string;
}

/**
 * Dashboard-ready hook: every expiring/expired document across all record
 * files, joined with employee names. Scoped to the provided employee list so
 * callers can pass auth-scoped employees.
 */
export function useExpiringDocuments(
  allEmployees: Pick<Employee, 'id' | 'name'>[],
  days: number = EXPIRY_ALERT_DAYS,
): ExpiringDocumentWithEmployee[] {
  const { items: files } = useEmployeeRecordFiles();
  const nameById = new Map(allEmployees.map((e) => [e.id, e.name]));
  const scoped = files.filter((f) => nameById.has(f.employeeId));
  return expiringDocuments(scoped, days).map((x) => ({
    ...x,
    employeeName: nameById.get(x.employeeId) ?? x.employeeId,
  }));
}

/* ────────────────────────────────────────────────────────────
 * PCB child-relief hint
 * ──────────────────────────────────────────────────────────── */

/**
 * Children flagged in the dependents section vs. the count on the Employee
 * record (used for PCB RM2,000-per-child relief). A mismatch hints HR to sync.
 */
export function childReliefHint(
  employee: Employee,
  file: EmployeeRecordFile | undefined,
): { fileChildren: number; employeeChildren: number; mismatch: boolean } {
  const fileChildren = (file?.dependents ?? []).filter((d) => d.isChild).length;
  const employeeChildren = employee.children ?? 0;
  return { fileChildren, employeeChildren, mismatch: fileChildren !== employeeChildren };
}

/** Unreturned company assets — feeds the offboarding clearance checklist idea. */
export function outstandingAssets(file: EmployeeRecordFile | undefined): AssetRecord[] {
  return (file?.assets ?? []).filter((a) => !a.returnedAt);
}
