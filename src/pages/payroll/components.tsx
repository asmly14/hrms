/**
 * Small shared building blocks for the payroll module.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Injects print CSS that hides everything except the element carrying
 * `areaClass` (and its children). index.css is core-owned, so module-level
 * print rules live here as an inline <style> tag.
 */
export function PrintAreaStyles({ areaClass }: { areaClass: string }) {
  return (
    <style>{`
@media print {
  body * { visibility: hidden; }
  .${areaClass}, .${areaClass} * { visibility: visible; }
  .${areaClass} {
    position: absolute;
    inset: 0 auto auto 0;
    width: 100%;
    margin: 0 !important;
    padding: 0 !important;
    border: none !important;
    box-shadow: none !important;
    background: #ffffff !important;
    color: #1c1917 !important;
  }
  .${areaClass} .print-text-muted { color: #57534e !important; }
  @page { margin: 12mm; }
}
`}</style>
  );
}

/** Consistent right-aligned money cell content. */
export function Money({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('tabular-nums', className)}>{children}</span>;
}

/** Statutory form section header used across output tables. */
export function FormHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {action}
    </div>
  );
}
