/**
 * Small shared building blocks for the public onboarding wizard —
 * field wrapper with label + error, and the company branding header.
 * Kept dependency-light: no auth, no tenant context (public route).
 */
import type { ReactNode } from 'react';
import { Building2 } from 'lucide-react';
import type { Company } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';

export function Field({
  id,
  label,
  required,
  optional,
  error,
  children,
  className,
}: {
  id?: string;
  label?: string;
  required?: boolean;
  optional?: boolean;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      {label && (
        <Label htmlFor={id} className="text-sm">
          {label}
          {required && <span className="ml-0.5 text-red-500">*</span>}
          {optional && (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">(optional)</span>
          )}
        </Label>
      )}
      {children}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

export function StepIntro({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="space-y-1">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {children && <p className="text-sm text-muted-foreground">{children}</p>}
    </div>
  );
}

/** Read-only branding banner resolved from the link's company — no session. */
export function BrandingHeader({ company, subtitle }: { company?: Company; subtitle?: string }) {
  const accent = company?.branding.accentColor || '#b45309';
  const logoText = company?.branding.logoText || company?.code || 'HR';
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4 sm:px-6">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white shadow-sm"
          style={{ backgroundColor: accent }}
          aria-hidden
        >
          {logoText.slice(0, 3).toUpperCase()}
        </span>
        <div className="min-w-0">
          <p className="truncate text-base font-semibold leading-tight">
            {company?.name ?? 'Employee Onboarding'}
          </p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Building2 className="h-3 w-3" />
            {subtitle ?? 'New-hire onboarding form'}
          </p>
        </div>
      </div>
    </header>
  );
}
