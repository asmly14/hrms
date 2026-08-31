/**
 * Org payroll report — one-click download of the owner-facing PDF for a
 * payroll run (cover summary, department breakdown, employee register,
 * exceptions). Rendered only for FINALIZED runs: draft figures are internal
 * review material and never leave the app as an official report.
 *
 * All heavy lifting lives in `@/lib/payrollReportPdf` — jsPDF is dynamically
 * imported there, so this button adds nothing to the eager bundle.
 */
import { useState } from 'react';
import { FileDown, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { downloadOrgReportPdf } from '@/lib/payrollReportPdf';
import type { PayrollRun } from '@/lib/types';
import { monthLabel } from './helpers';
import { Button } from '@/components/ui/button';

export default function OrgPayrollReport({ run }: { run: PayrollRun }) {
  const [generating, setGenerating] = useState(false);

  const handleDownload = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      const result = await downloadOrgReportPdf(run.id);
      if (!result) {
        toast.error('Could not build the org report', {
          description: 'The payroll run was not found — it may have been replaced by a re-run.',
        });
        return;
      }
      toast.success(`Org report for ${monthLabel(run.monthKey)} downloaded`, {
        description: `${result.pageCount} page(s), ${result.headcount} employee(s) → ${result.fileName}`,
      });
    } catch (err) {
      toast.error('PDF generation failed', {
        description: err instanceof Error ? err.message : 'Unknown error — please try again.',
      });
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Button variant="outline" onClick={handleDownload} disabled={generating}>
      {generating ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <FileDown className="h-4 w-4" />
      )}
      Org report (PDF)
    </Button>
  );
}
