/**
 * JdSheet — clean, printable job-description document for one position.
 * Renders inside a Dialog on screen; the Print button uses window.print()
 * with a print-only stylesheet that isolates the sheet (.jd-print-sheet).
 */
import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { effectiveGrade, type PositionProfile } from '@/lib/orgChart';
import { fmtDate, fmtRM } from '@/lib/utils';
import type { Department, Position } from '@/lib/types';

/** Print isolation: everything except the sheet is hidden while printing. */
const PRINT_CSS = `
@media print {
  body * { visibility: hidden !important; }
  .jd-print-sheet, .jd-print-sheet * { visibility: visible !important; }
  .jd-print-sheet {
    position: fixed !important;
    inset: 0 !important;
    width: 100% !important;
    max-height: none !important;
    overflow: visible !important;
    padding: 2rem !important;
    border: none !important;
    box-shadow: none !important;
    background: #fff !important;
    color: #1c1917 !important;
  }
  .jd-no-print { display: none !important; }
}
`;

const LEVEL_LABEL: Record<Position['level'], string> = {
  junior: 'Junior',
  senior: 'Senior',
  lead: 'Lead',
  manager: 'Manager',
  exec: 'Executive',
};

export default function JdSheet({
  open,
  onOpenChange,
  position,
  profile,
  department,
  reportsToTitle,
  benchmarkMedian,
  companyName,
  actual,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  position: Position;
  profile?: PositionProfile;
  department?: Department;
  reportsToTitle?: string;
  benchmarkMedian?: number;
  companyName: string;
  actual: number;
}) {
  const grade = effectiveGrade(position, profile);
  const budget = profile?.headcountBudget;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <style>{PRINT_CSS}</style>
      <DialogContent className="jd-print-sheet max-h-[92vh] max-w-3xl overflow-y-auto">
        <div className="jd-no-print sticky top-0 z-10 -mx-6 -mt-6 mb-4 flex items-center justify-between border-b bg-card/95 px-6 py-3 backdrop-blur">
          <span className="text-sm font-medium">Job description preview</span>
          <Button size="sm" onClick={() => window.print()}>
            <Printer className="mr-1.5 h-4 w-4" /> Print
          </Button>
        </div>

        <div className="space-y-5 text-stone-800 dark:text-stone-200">
          <header className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-amber-700 dark:text-amber-400">
                {companyName}
              </p>
              <h1 className="mt-1 text-2xl font-bold tracking-tight">{position.title}</h1>
              <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
                {department?.name ?? 'Unassigned'} · Grade {grade} · {LEVEL_LABEL[position.level]}
              </p>
            </div>
            <div className="shrink-0 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-right dark:border-amber-900 dark:bg-amber-950/40">
              <p className="text-[11px] uppercase tracking-wide text-amber-700 dark:text-amber-400">Salary band</p>
              <p className="text-sm font-semibold">
                {fmtRM(position.minSalary)} – {fmtRM(position.maxSalary)}
              </p>
              {typeof benchmarkMedian === 'number' && (
                <p className="text-[11px] text-stone-500 dark:text-stone-400">
                  Market median {fmtRM(benchmarkMedian)}
                </p>
              )}
            </div>
          </header>

          <div className="grid grid-cols-2 gap-3 rounded-lg border p-3 text-sm sm:grid-cols-4">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-stone-500">Reports to</p>
              <p className="font-medium">{reportsToTitle ?? '— (organisation root)'}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-stone-500">Department</p>
              <p className="font-medium">{department?.name ?? '—'}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-stone-500">Headcount</p>
              <p className="font-medium">
                {actual} on board{typeof budget === 'number' ? ` / ${budget} budgeted` : ''}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-stone-500">Issued</p>
              <p className="font-medium">{fmtDate(new Date())}</p>
            </div>
          </div>

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
              About the role
            </h2>
            <p className="mt-2 whitespace-pre-line text-sm leading-relaxed">
              {profile?.jobDescription?.trim() ||
                'No role summary recorded yet — open this position in the organisation manager to write one.'}
            </p>
          </section>

          <Separator />

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
              Key responsibilities
            </h2>
            {profile && profile.responsibilities.length > 0 ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed">
                {profile.responsibilities.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-stone-500">Not specified.</p>
            )}
          </section>

          <Separator />

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
              Requirements & qualifications
            </h2>
            {profile && profile.qualifications.length > 0 ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed">
                {profile.qualifications.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-stone-500">Not specified.</p>
            )}
          </section>

          <footer className="border-t pt-3 text-[11px] text-stone-500">
            Generated from {companyName} organisation records on {fmtDate(new Date())}. Salary band is the
            approved range for this grade; the market median references the Malaysian 2025–26 benchmark
            dataset (Klang-Valley baseline, state-adjusted).
          </footer>
        </div>
      </DialogContent>
    </Dialog>
  );
}
