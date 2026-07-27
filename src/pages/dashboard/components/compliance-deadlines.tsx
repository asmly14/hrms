/**
 * Compliance Deadlines widget — next statutory filing dates with
 * countdown badges (computed in ../lib, no hardcoded dates).
 */
import { CalendarClock } from 'lucide-react';
import { daysBetween, fmtDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { complianceDeadlines, todayISO } from '../lib';

export function ComplianceDeadlines() {
  const today = todayISO();
  const deadlines = complianceDeadlines();

  return (
    <Card className="rounded-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock className="h-4 w-4 text-amber-600" />
          Compliance deadlines
        </CardTitle>
        <CardDescription>Next statutory submission dates</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {deadlines.map((d) => {
            const days = daysBetween(today, d.due);
            const label = days <= 0 ? 'Due today' : days === 1 ? '1 day left' : `${days} days left`;
            const variant = days <= 7 ? 'destructive' : days <= 30 ? 'default' : 'secondary';
            return (
              <li key={d.id} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{d.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {fmtDate(d.due)} · {d.note}
                  </p>
                </div>
                <Badge variant={variant} className="mt-0.5 shrink-0">
                  {label}
                </Badge>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
