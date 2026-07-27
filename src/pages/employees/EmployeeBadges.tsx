import { Badge } from '@/components/ui/badge';
import type { EmployeeStatus, EmploymentType } from '@/lib/types';

const STATUS_STYLES: Record<EmployeeStatus, string> = {
  active: 'border-transparent bg-lime-100 text-lime-800',
  probation: 'border-transparent bg-amber-100 text-amber-800',
  resigned: 'border-transparent bg-stone-200 text-stone-600',
};

const TYPE_STYLES: Record<EmploymentType, string> = {
  'full-time': 'border-transparent bg-stone-200 text-stone-700',
  'part-time': 'border-transparent bg-orange-100 text-orange-800',
  contract: 'border-transparent bg-yellow-100 text-yellow-800',
};

export function StatusBadge({ status }: { status: EmployeeStatus }) {
  return (
    <Badge variant="outline" className={STATUS_STYLES[status]}>
      {status === 'active' ? 'Active' : status === 'probation' ? 'Probation' : 'Resigned'}
    </Badge>
  );
}

export function TypeBadge({ type }: { type: EmploymentType }) {
  const label = type === 'full-time' ? 'Full-time' : type === 'part-time' ? 'Part-time' : 'Contract';
  return (
    <Badge variant="outline" className={TYPE_STYLES[type]}>
      {label}
    </Badge>
  );
}
