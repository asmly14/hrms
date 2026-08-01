/**
 * Public onboarding wizard — form state, per-step validation, draft mapping.
 * Pure functions (no React, no storage) so the page stays a thin shell.
 */
import type {
  AcademicEntry,
  EmergencyContact,
  OnboardDocKind,
  OnboardDocument,
  OnboardDraft,
  OnboardLink,
  OnboardSubmission,
} from '@/lib/onboardLinks';
import { isValidIc, normalizeIc, REQUIRED_DOC_KINDS } from '@/lib/onboardLinks';
import type { EmploymentType, Gender, MaritalStatus, StateCode } from '@/lib/types';

export type StepKey =
  | 'personal'
  | 'contact'
  | 'emergency'
  | 'academics'
  | 'documents'
  | 'declaration';

export const STEP_ORDER: StepKey[] = [
  'personal',
  'contact',
  'emergency',
  'academics',
  'documents',
  'declaration',
];

export const STEP_TITLES: Record<StepKey, string> = {
  personal: 'Personal details',
  contact: 'Contact, bank & statutory',
  emergency: 'Emergency contacts',
  academics: 'Academic qualifications',
  documents: 'Document uploads',
  declaration: 'Declaration',
};

export interface OnboardFormState {
  // Step 1 — personal (+ employment context)
  name: string;
  ic: string;
  dob: string;
  gender: Gender | '';
  maritalStatus: MaritalStatus | '';
  nationality: string;
  phone: string;
  email: string;
  positionId: string;
  departmentId: string;
  joinDate: string;
  employmentType: EmploymentType | '';
  // Step 2 — contact / bank / statutory
  address: string;
  state: StateCode | '';
  bankName: string;
  bankAccount: string;
  epfNo: string;
  socsoNo: string;
  taxNo: string;
  // Step 3 — emergency contacts
  emergencyContacts: EmergencyContact[];
  // Step 4 — academics
  academics: AcademicEntry[];
  // Step 5 — documents
  documents: OnboardDocument[];
  // Step 6 — declaration
  declarationAccepted: boolean;
}

export type FormErrors = Record<string, string>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const YEAR_RE = /^\d{4}$/;

export function emptyForm(link?: OnboardLink): OnboardFormState {
  return {
    name: '',
    ic: '',
    dob: '',
    gender: '',
    maritalStatus: '',
    nationality: 'Malaysian',
    phone: '',
    email: '',
    positionId: link?.positionId ?? '',
    departmentId: link?.departmentId ?? '',
    joinDate: '',
    employmentType: '',
    address: '',
    state: '',
    bankName: '',
    bankAccount: '',
    epfNo: '',
    socsoNo: '',
    taxNo: '',
    emergencyContacts: [{ name: '', relation: '', phone: '' }],
    academics: [],
    documents: [],
    declarationAccepted: false,
  };
}

/** Prefill the wizard from a rejected submission so the applicant only fixes
 *  what HR flagged (documents must be re-uploaded — bytes are not refilled). */
export function prefillFromSubmission(sub: OnboardSubmission): OnboardFormState {
  const p = sub.personal;
  return {
    name: p.name,
    ic: p.ic,
    dob: p.dob,
    gender: p.gender,
    maritalStatus: p.maritalStatus,
    nationality: p.nationality,
    phone: p.phone,
    email: p.email,
    positionId: sub.employment.positionId ?? '',
    departmentId: sub.employment.departmentId ?? '',
    joinDate: sub.employment.joinDate,
    employmentType: sub.employment.employmentType,
    address: p.address,
    state: p.state,
    bankName: p.bankName,
    bankAccount: p.bankAccount,
    epfNo: p.epfNo ?? '',
    socsoNo: p.socsoNo ?? '',
    taxNo: p.taxNo ?? '',
    emergencyContacts:
      sub.emergencyContacts.length > 0
        ? sub.emergencyContacts.map((c) => ({ ...c }))
        : [{ name: '', relation: '', phone: '' }],
    academics: sub.academics.map((a) => ({ ...a })),
    documents: [],
    declarationAccepted: false,
  };
}

export function validateStep(form: OnboardFormState, step: StepKey): FormErrors {
  const errors: FormErrors = {};

  if (step === 'personal') {
    if (!form.name.trim()) errors.name = 'Full name is required';
    if (!form.ic.trim()) errors.ic = 'NRIC is required';
    else if (!isValidIc(normalizeIc(form.ic)))
      errors.ic = 'Enter your NRIC as ######-##-#### (e.g. 900101-14-5566)';
    if (!form.dob) errors.dob = 'Date of birth is required';
    else if (new Date(`${form.dob}T00:00:00`) >= new Date())
      errors.dob = 'Date of birth must be in the past';
    if (!form.gender) errors.gender = 'Select your gender';
    if (!form.maritalStatus) errors.maritalStatus = 'Select your marital status';
    if (!form.nationality.trim()) errors.nationality = 'Nationality is required';
    if (!form.phone.trim()) errors.phone = 'Phone number is required';
    if (!form.email.trim()) errors.email = 'Email is required';
    else if (!EMAIL_RE.test(form.email.trim())) errors.email = 'Enter a valid email address';
    if (!form.joinDate) errors.joinDate = 'Expected start date is required';
    if (!form.employmentType) errors.employmentType = 'Select the employment type';
  }

  if (step === 'contact') {
    if (!form.address.trim()) errors.address = 'Home address is required';
    if (!form.state) errors.state = 'Select your state';
    if (!form.bankName.trim()) errors.bankName = 'Bank name is required (salary is paid by bank)';
    if (!form.bankAccount.trim()) errors.bankAccount = 'Bank account number is required';
    // epfNo / socsoNo / taxNo are intentionally optional — HR completes them
    // during statutory registration when the applicant has none yet.
  }

  if (step === 'emergency') {
    if (form.emergencyContacts.length === 0) {
      errors.emergency = 'Add at least one emergency contact';
    }
    form.emergencyContacts.forEach((c, i) => {
      if (!c.name.trim()) errors[`ec-name-${i}`] = 'Name required';
      if (!c.relation.trim()) errors[`ec-relation-${i}`] = 'Relation required';
      if (!c.phone.trim()) errors[`ec-phone-${i}`] = 'Phone required';
    });
  }

  if (step === 'academics') {
    if (form.academics.length === 0) {
      errors.academics = 'Add at least one qualification (SPM/STPM or higher)';
    }
    form.academics.forEach((a, i) => {
      if (!a.institution.trim()) errors[`ac-institution-${i}`] = 'Institution required';
      if (!a.course.trim()) errors[`ac-course-${i}`] = 'Course / field required';
      if (!YEAR_RE.test(a.fromYear.trim())) errors[`ac-from-${i}`] = 'Year (YYYY)';
      if (!YEAR_RE.test(a.toYear.trim())) errors[`ac-to-${i}`] = 'Year (YYYY)';
      else if (
        YEAR_RE.test(a.fromYear.trim()) &&
        Number(a.toYear.trim()) < Number(a.fromYear.trim())
      ) {
        errors[`ac-to-${i}`] = 'Must be ≥ from year';
      }
    });
  }

  if (step === 'documents') {
    const present = new Set(form.documents.map((d) => d.kind));
    for (const kind of REQUIRED_DOC_KINDS) {
      if (!present.has(kind)) errors[`doc-${kind}`] = 'Required';
    }
  }

  if (step === 'declaration') {
    if (!form.declarationAccepted) errors.declaration = 'Please accept the declaration to submit';
  }

  return errors;
}

/** Validate every step — used by the final submit gate. */
export function validateAll(form: OnboardFormState): FormErrors {
  return STEP_ORDER.reduce<FormErrors>((acc, step) => ({ ...acc, ...validateStep(form, step) }), {});
}

/** First step that has errors — for jumping the wizard back on failed submit. */
export function firstInvalidStep(form: OnboardFormState): StepKey | null {
  for (const step of STEP_ORDER) {
    if (Object.keys(validateStep(form, step)).length > 0) return step;
  }
  return null;
}

export function emptyAcademic(): AcademicEntry {
  return { level: 'Degree', institution: '', course: '', fromYear: '', toYear: '', grade: '' };
}

export function missingDocKinds(documents: OnboardDocument[]): OnboardDocKind[] {
  const present = new Set(documents.map((d) => d.kind));
  return REQUIRED_DOC_KINDS.filter((k) => !present.has(k));
}

/** Map validated form state to the submission draft the lib persists. */
export function formToDraft(form: OnboardFormState): OnboardDraft {
  return {
    personal: {
      name: form.name.trim(),
      ic: normalizeIc(form.ic),
      dob: form.dob,
      gender: form.gender as Gender,
      maritalStatus: form.maritalStatus as MaritalStatus,
      phone: form.phone.trim(),
      email: form.email.trim().toLowerCase(),
      address: form.address.trim(),
      state: form.state as StateCode,
      nationality: form.nationality.trim(),
      bankName: form.bankName.trim(),
      bankAccount: form.bankAccount.trim(),
      epfNo: form.epfNo.trim() || undefined,
      socsoNo: form.socsoNo.trim() || undefined,
      taxNo: form.taxNo.trim() || undefined,
    },
    emergencyContacts: form.emergencyContacts.map((c) => ({
      name: c.name.trim(),
      relation: c.relation.trim(),
      phone: c.phone.trim(),
    })),
    academics: form.academics.map((a) => ({
      level: a.level,
      institution: a.institution.trim(),
      course: a.course.trim(),
      fromYear: a.fromYear.trim(),
      toYear: a.toYear.trim(),
      grade: a.grade?.trim() || undefined,
    })),
    employment: {
      positionId: form.positionId || undefined,
      departmentId: form.departmentId || undefined,
      joinDate: form.joinDate,
      employmentType: form.employmentType as EmploymentType,
    },
    documents: form.documents,
    declarationAccepted: form.declarationAccepted,
  };
}
