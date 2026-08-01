/**
 * Public applicant onboarding form — /onboard/:token.
 *
 * Mounted OUTSIDE the auth guard (mirrors /login). The page:
 *   • resolves the invite link by token via a cross-tenant scan (no session,
 *     no active-tenant dependency);
 *   • renders company branding read-only from the global company directory;
 *   • walks the applicant through a 6-step wizard (personal → contact/bank →
 *     emergency contacts → academics → documents → PDPA declaration);
 *   • persists the submission against the link's company and shows a success
 *     screen. Invalid / expired / revoked / already-submitted tokens each get
 *     a friendly status card.
 *
 * All heavy lifting (storage, token resolution, mapping) lives in
 * @/lib/onboardLinks; step validation lives in ./formState.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CalendarClock,
  Check,
  CheckCircle2,
  FileWarning,
  Hourglass,
  Link2Off,
  Send,
  ShieldX,
} from 'lucide-react';
import { getCollection } from '@/lib/db';
import {
  resolvePublicLink,
  submitOnboardForm,
  type OnboardSubmission,
  type ResolvedPublicLink,
} from '@/lib/onboardLinks';
import type { Department, Position } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { BrandingHeader } from './fields';
import {
  STEP_ORDER,
  STEP_TITLES,
  emptyForm,
  firstInvalidStep,
  formToDraft,
  prefillFromSubmission,
  validateStep,
  type FormErrors,
  type OnboardFormState,
} from './formState';
import PersonalStep from './steps/PersonalStep';
import ContactBankStep from './steps/ContactBankStep';
import EmergencyStep from './steps/EmergencyStep';
import AcademicsStep from './steps/AcademicsStep';
import DocumentsStep from './steps/DocumentsStep';
import DeclarationStep from './steps/DeclarationStep';

function StatusCard({
  resolved,
  icon: Icon,
  title,
  children,
}: {
  resolved: ResolvedPublicLink;
  icon: typeof Link2Off;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-stone-50 text-foreground dark:bg-stone-950">
      <BrandingHeader company={resolved.company} />
      <main className="mx-auto max-w-md px-4 py-12">
        <Card className="rounded-xl">
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-300">
              <Icon className="h-6 w-6" />
            </span>
            <h1 className="text-lg font-semibold">{title}</h1>
            <div className="text-sm text-muted-foreground">{children}</div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

export default function OnboardFormPage() {
  const { token = '' } = useParams<{ token: string }>();
  const [resolved] = useState<ResolvedPublicLink>(() => resolvePublicLink(token));
  const [form, setForm] = useState<OnboardFormState>(() =>
    resolved.resubmission ? prefillFromSubmission(resolved.resubmission) : emptyForm(resolved.link),
  );
  const [stepIdx, setStepIdx] = useState(0);
  const [errors, setErrors] = useState<FormErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState<OnboardSubmission | null>(null);

  // Read-only org data for the link's company (explicit tenant — no session).
  const companyId = resolved.link?.companyId;
  const [positions] = useState<Position[]>(() =>
    companyId ? getCollection<Position>('positions', companyId) : [],
  );
  const [departments] = useState<Department[]>(() =>
    companyId ? getCollection<Department>('departments', companyId) : [],
  );

  useEffect(() => {
    document.title = resolved.company
      ? `Onboarding — ${resolved.company.name}`
      : 'Employee Onboarding Form';
  }, [resolved.company]);

  const patch = (p: Partial<OnboardFormState>) => {
    setForm((f) => ({ ...f, ...p }));
    setErrors({});
    setSubmitError(null);
  };

  /* ── Token problem states ── */
  if (resolved.reason === 'not-found') {
    return (
      <StatusCard resolved={resolved} icon={Link2Off} title="This onboarding link is invalid">
        <p>
          The link may have been typed incorrectly. Please check the URL from your HR team and try
          again.
        </p>
      </StatusCard>
    );
  }
  if (resolved.reason === 'revoked') {
    return (
      <StatusCard resolved={resolved} icon={ShieldX} title="This link has been revoked">
        <p>
          HR has deactivated this onboarding link. Please contact your HR representative for a new
          one.
        </p>
      </StatusCard>
    );
  }
  if (resolved.reason === 'expired') {
    return (
      <StatusCard resolved={resolved} icon={CalendarClock} title="This link has expired">
        <p>
          The onboarding link expired on{' '}
          <span className="font-medium text-foreground">
            {resolved.link?.expiresAt.slice(0, 10)}
          </span>
          . Please contact HR for a fresh link.
        </p>
      </StatusCard>
    );
  }
  if (resolved.reason === 'submitted') {
    return (
      <StatusCard resolved={resolved} icon={Hourglass} title="Submission under review">
        <p>
          Your onboarding form has already been submitted and is waiting for HR to review it.
          You&apos;ll be contacted once it&apos;s processed — no further action is needed.
        </p>
      </StatusCard>
    );
  }
  if (resolved.reason === 'approved') {
    return (
      <StatusCard resolved={resolved} icon={CheckCircle2} title="You're all set">
        <p>
          Your onboarding submission has been approved and your employee record has been created.
          See you on your first day!
        </p>
      </StatusCard>
    );
  }

  const { link, company } = resolved;
  if (!link) return null;

  /* ── Success screen ── */
  if (done) {
    return (
      <div className="min-h-screen bg-stone-50 text-foreground dark:bg-stone-950">
        <BrandingHeader company={company} />
        <main className="mx-auto max-w-md px-4 py-12">
          <Card className="rounded-xl">
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-lime-100 text-lime-700 dark:bg-lime-950/60 dark:text-lime-400">
                <CheckCircle2 className="h-6 w-6" />
              </span>
              <h1 className="text-lg font-semibold">Submission received — thank you!</h1>
              <p className="text-sm text-muted-foreground">
                Your details have been sent to {company?.name ?? 'HR'}. They will review your
                information and reach out if anything else is needed before your first day.
              </p>
              <p className="mt-2 rounded-lg bg-stone-100 px-3 py-1.5 text-xs text-muted-foreground dark:bg-stone-800">
                Reference: {done.id.slice(0, 8).toUpperCase()} · keep this for your records
              </p>
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  /* ── Wizard ── */
  const stepKey = STEP_ORDER[stepIdx]!;
  const isLast = stepIdx === STEP_ORDER.length - 1;

  const next = () => {
    const errs = validateStep(form, stepKey);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setStepIdx((i) => Math.min(STEP_ORDER.length - 1, i + 1));
    window.scrollTo({ top: 0 });
  };
  const back = () => {
    setErrors({});
    setStepIdx((i) => Math.max(0, i - 1));
    window.scrollTo({ top: 0 });
  };

  const submit = () => {
    // Validate every step; jump back to the first failing one.
    const badStep = firstInvalidStep(form);
    if (badStep) {
      setErrors(validateStep(form, badStep));
      setStepIdx(STEP_ORDER.indexOf(badStep));
      return;
    }
    setSubmitting(true);
    const result = submitOnboardForm(link, formToDraft(form));
    setSubmitting(false);
    if (result.ok) {
      setDone(result.submission);
      window.scrollTo({ top: 0 });
    } else {
      setSubmitError(result.error);
    }
  };

  return (
    <div className="min-h-screen bg-stone-50 text-foreground dark:bg-stone-950">
      <BrandingHeader company={company} subtitle={`Onboarding for ${link.label}`} />

      <main className="mx-auto max-w-3xl px-4 py-6 sm:py-10">
        {resolved.resubmission && (
          <div className="mb-5 flex items-start gap-2 rounded-xl border border-amber-300/70 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
            <FileWarning className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              HR returned your previous submission
              {resolved.resubmission.reviewNotes
                ? ` with this note: “${resolved.resubmission.reviewNotes}”.`
                : '.'}{' '}
              Please review your details and submit again. Documents must be re-uploaded.
            </p>
          </div>
        )}

        {/* Stepper */}
        <ol className="mb-6 flex items-center gap-1 overflow-x-auto pb-1">
          {STEP_ORDER.map((key, i) => {
            const doneStep = i < stepIdx;
            const current = i === stepIdx;
            return (
              <li key={key} className="flex shrink-0 items-center gap-1">
                <div
                  className={cn(
                    'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
                    current && 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-300',
                    doneStep && 'bg-lime-100 text-lime-800 dark:bg-lime-950/60 dark:text-lime-300',
                    !current && !doneStep && 'bg-stone-100 text-stone-500 dark:bg-stone-800',
                  )}
                >
                  {doneStep ? <Check className="h-3 w-3" /> : <span>{i + 1}</span>}
                  <span className="hidden sm:inline">{STEP_TITLES[key]}</span>
                </div>
                {i < STEP_ORDER.length - 1 && <span className="h-px w-3 bg-border" />}
              </li>
            );
          })}
        </ol>
        <p className="mb-4 text-xs text-muted-foreground sm:hidden">
          Step {stepIdx + 1} of {STEP_ORDER.length} — {STEP_TITLES[stepKey]}
        </p>

        <Card className="rounded-xl">
          <CardContent className="p-4 sm:p-6">
            {stepKey === 'personal' && (
              <PersonalStep
                form={form}
                patch={patch}
                errors={errors}
                link={link}
                positions={positions}
                departments={departments}
              />
            )}
            {stepKey === 'contact' && (
              <ContactBankStep form={form} patch={patch} errors={errors} />
            )}
            {stepKey === 'emergency' && (
              <EmergencyStep form={form} patch={patch} errors={errors} />
            )}
            {stepKey === 'academics' && (
              <AcademicsStep form={form} patch={patch} errors={errors} />
            )}
            {stepKey === 'documents' && (
              <DocumentsStep form={form} patch={patch} errors={errors} />
            )}
            {stepKey === 'declaration' && (
              <DeclarationStep form={form} patch={patch} errors={errors} company={company} />
            )}

            {submitError && (
              <div
                role="alert"
                className="mt-5 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {submitError}
              </div>
            )}

            {/* Nav */}
            <div className="mt-6 flex items-center justify-between border-t pt-4">
              <Button variant="outline" onClick={back} disabled={stepIdx === 0 || submitting}>
                <ArrowLeft className="mr-1.5 h-4 w-4" /> Back
              </Button>
              {isLast ? (
                <Button
                  onClick={submit}
                  disabled={submitting}
                  className="bg-amber-600 text-white hover:bg-amber-700"
                >
                  <Send className="mr-1.5 h-4 w-4" />
                  {submitting ? 'Submitting…' : 'Submit onboarding form'}
                </Button>
              ) : (
                <Button onClick={next}>
                  Next <ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Your information is submitted directly to {company?.name ?? 'the company'} and handled
          under the Personal Data Protection Act 2010.
        </p>
      </main>
    </div>
  );
}
