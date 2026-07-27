/**
 * Upcoming public holidays widget — next 5 holidays for the HQ state
 * (Settings.hqState, default KUL) via getHolidays, including next-year
 * rollover. EA 1955 s.60D compulsory holidays and tentative dates are badged.
 */
import { useMemo } from 'react';
import { CalendarDays } from 'lucide-react';
import { useCollection } from '@/lib/db';
import { getHolidays, stateInfo } from '@/lib/holidays';
import { fmtDate } from '@/lib/utils';
import type { Holiday, Settings } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { todayISO } from '../lib';

function weekday(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short' });
}

export function UpcomingHolidays() {
  const { items: settingsItems } = useCollection<Settings>('settings');
  // Subscribing to the 'holidays' collection keeps admin overrides reactive.
  const { items: overrides } = useCollection<Holiday>('holidays');
  const hq = settingsItems[0]?.hqState ?? 'KUL';

  const upcoming = useMemo(() => {
    const year = new Date().getFullYear();
    const today = todayISO();
    return [...getHolidays(year, hq), ...getHolidays(year + 1, hq)]
      .filter((h) => h.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 5);
    // overrides retrigger the memo when admin holiday overrides change
  }, [hq, overrides]);

  return (
    <Card className="rounded-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarDays className="h-4 w-4 text-amber-600" />
          Upcoming public holidays
        </CardTitle>
        <CardDescription>
          {stateInfo(hq).name}
          {upcoming.length > 0 ? ` · next ${upcoming.length}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {upcoming.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No upcoming holidays found for {stateInfo(hq).name}.
          </p>
        ) : (
          <ul className="space-y-3">
            {upcoming.map((h) => (
              <li key={`${h.date}|${h.name}`} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{h.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {weekday(h.date)}, {fmtDate(h.date)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  {h.isCompulsoryEA && <Badge variant="secondary">EA s.60D</Badge>}
                  {h.tentative && <Badge variant="outline">Tentative</Badge>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
