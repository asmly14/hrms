/** Small shared building blocks for the Settings module. */
import { useRef, useState, type ReactNode } from 'react';
import { Check, Save, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';

/** Actor name stamped on audit entries made from the Settings module. */
export const DEMO_ACTOR = 'Admin (demo)';

export function SectionCard(props: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const { icon: Icon, title, description, action, children } = props;
  return (
    <Card className="rounded-xl">
      <CardHeader>
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-amber-600" />
          <CardTitle className="text-base">{title}</CardTitle>
        </div>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{props.label}</Label>
      {props.children}
      {props.hint ? <p className="text-xs text-muted-foreground">{props.hint}</p> : null}
    </div>
  );
}

/** Parses a number input value, falling back when blank / non-numeric. */
export function numOr(value: string, fallback: number): number {
  // Number('') === 0 — a cleared field must hit the fallback, not save 0.
  if (value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Save button with a transient "Saved" confirmation. */
export function SaveButton({ onSave, disabled }: { onSave: () => void; disabled?: boolean }) {
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <Button
      size="sm"
      disabled={disabled}
      onClick={() => {
        onSave();
        setSaved(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setSaved(false), 2200);
      }}
    >
      {saved ? <Check className="mr-1.5 h-4 w-4" /> : <Save className="mr-1.5 h-4 w-4" />}
      {saved ? 'Saved' : 'Save changes'}
    </Button>
  );
}
