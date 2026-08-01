/**
 * Shared presentational helpers for the contracts module (non-component
 * module so pages stay react-refresh safe).
 */
import type { ContractKind, ContractStatus, EmploymentContract } from '@/lib/contracts';

export function statusBadgeClass(s: ContractStatus): string {
  switch (s) {
    case 'active':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-400';
    case 'expiring':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-400';
    case 'expired':
      return 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-400';
    case 'draft':
      return 'bg-stone-200/80 text-stone-700 dark:bg-stone-800 dark:text-stone-300';
    case 'renewed':
      return 'bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-400';
    case 'terminated':
      return 'bg-stone-300/60 text-stone-600 line-through dark:bg-stone-800 dark:text-stone-400';
  }
}

export function kindBadgeClass(kind: ContractKind): string {
  return kind === 'of-service'
    ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-400'
    : 'bg-stone-200/80 text-stone-700 dark:bg-stone-800 dark:text-stone-300';
}

export function remunerationUnit(c: EmploymentContract): string {
  switch (c.remuneration.mode) {
    case 'monthly-salary':
      return '/mo';
    case 'daily':
      return '/day';
    case 'hourly':
      return '/hr';
    case 'fixed-fee':
      return 'fixed';
    case 'per-deliverable':
      return '/deliverable';
  }
}
