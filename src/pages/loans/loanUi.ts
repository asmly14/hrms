/**
 * Shared display constants for the loans module pages (kept component-free
 * so the page files stay fast-refresh clean).
 */
import type { EmployeeLoan } from '@/lib/loans';

export const LOAN_STATUS_LABELS: Record<EmployeeLoan['status'], string> = {
  active: 'Active',
  settled: 'Settled',
  'written-off': 'Written off',
  cancelled: 'Cancelled',
};

export function loanStatusVariant(status: EmployeeLoan['status']): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'active': return 'default';
    case 'settled': return 'secondary';
    case 'written-off': return 'destructive';
    default: return 'outline';
  }
}
