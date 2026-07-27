/**
 * Clock In/Out panel — geolocation-aware mobile time clock.
 * Reads office locations from the core `getOfficeLocations()` helper when
 * available, else the 'settings' collection, else demo defaults.
 * Scoping: Employee/Manager always clock as their own linked employee;
 * Admin/HR (and the pre-auth demo) get a kiosk picker.
 */
import { useMemo, useState } from 'react';
import {
  AlertTriangle, Briefcase, Clock3, Loader2, LogIn, LogOut, MapPin, ShieldCheck,
} from 'lucide-react';
import { logAudit, useCollection } from '@/lib/db';
import type { Employee } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  geofenceVerdict, isLate, nowHHmm, shiftForEmployee, todayISO,
  useOfficeLocations, useRotations, type AttendanceX, type SettingsX, type ShiftX,
} from './model';
import { actorName, isKiosk, useAuthSafe } from './useAuthSafe';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

/** Statuses that a clock-in must never overwrite (approved leave / rest day / holiday). */
const PROTECTED_STATUSES = new Set(['leave', 'rest-day', 'holiday']);

type GeoState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'ok'; lat: number; lng: number }
  | { kind: 'failed'; reason: string };

function GeoBadge({ record }: { record: AttendanceX | undefined }) {
  if (!record?.clockIn) return null;
  if (record.workMode === 'job-site') {
    return (
      <Badge variant="secondary" className="gap-1">
        <Briefcase className="h-3 w-3" /> Job site{record.jobSite ? ` · ${record.jobSite}` : ''}
      </Badge>
    );
  }
  if (record.geoStatus === 'inside') {
    return (
      <Badge className="gap-1 bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
        <MapPin className="h-3 w-3" /> Inside geofence
        {record.geoDistanceM !== undefined ? ` · ${Math.round(record.geoDistanceM)} m` : ''}
      </Badge>
    );
  }
  if (record.geoStatus === 'outside') {
    return (
      <Badge className="gap-1 bg-amber-100 text-amber-800 hover:bg-amber-100">
        <MapPin className="h-3 w-3" /> Outside geofence
        {record.geoDistanceM !== undefined ? ` · ${Math.round(record.geoDistanceM)} m from ${record.geoPlace}` : ''}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 border-amber-300 text-amber-700">
      <AlertTriangle className="h-3 w-3" /> Flagged · location unavailable
    </Badge>
  );
}

export default function ClockPanel() {
  const auth = useAuthSafe();
  const kiosk = isKiosk(auth); // Admin/HR (or pre-auth demo) may clock for anyone
  const selfId = auth?.employeeId ?? null;
  const { items: employees } = useCollection<Employee>('employees');
  const { items: settingsItems } = useCollection<SettingsX>('settings');
  const { items: shifts } = useCollection<ShiftX>('shifts');
  const { items: attendance, add, update } = useCollection<AttendanceX>('attendance');
  const rotations = useRotations();

  const active = useMemo(() => {
    const visible = auth ? auth.scopeEmployees(employees) : employees;
    return visible
      .filter((e) => e.status !== 'resigned')
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [employees, auth]);
  const [employeeId, setEmployeeId] = useState<string>('');
  // Kiosk: picked employee (default = own linked employee, else first).
  // Non-kiosk: ALWAYS the auth-linked employee — no impersonation possible.
  const emp = kiosk
    ? active.find((e) => e.id === employeeId) ?? active.find((e) => e.id === selfId) ?? active[0]
    : active.find((e) => e.id === selfId);

  const [workMode, setWorkMode] = useState<'office' | 'job-site'>('office');
  const [jobSite, setJobSite] = useState('');
  const [geo, setGeo] = useState<GeoState>({ kind: 'idle' });
  const [message, setMessage] = useState<string>('');

  const today = todayISO();
  const shift = emp ? shiftForEmployee(emp, shifts, rotations, today) : undefined;
  const record = emp
    ? attendance.find((a) => a.employeeId === emp.id && a.date === today)
    : undefined;

  const { locations, isDefault } = useOfficeLocations(settingsItems[0]);

  const captureLocation = (): Promise<GeoState> =>
    new Promise((resolve) => {
      if (!('geolocation' in navigator)) {
        const failed: GeoState = { kind: 'failed', reason: 'Geolocation not supported by this browser' };
        resolve(failed);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ kind: 'ok', lat: pos.coords.latitude, lng: pos.coords.longitude }),
        (err) =>
          resolve({
            kind: 'failed',
            reason: err.code === err.PERMISSION_DENIED ? 'Location permission denied' : 'Position unavailable',
          }),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 },
      );
    });

  const doClockIn = async () => {
    if (!emp) return;
    if (record?.clockIn) return;
    if (workMode === 'job-site' && !jobSite.trim()) {
      setMessage('Enter the job-site name before clocking in (required for service staff).');
      return;
    }
    setMessage('');
    setGeo({ kind: 'requesting' });
    const result = workMode === 'job-site' ? ({ kind: 'failed', reason: 'Job-site mode' } as GeoState) : await captureLocation();
    setGeo(result);

    const at = new Date();
    const time = nowHHmm();
    // NOTE: no `status` here — see the B1 guard below before applying it.
    let patch: Partial<AttendanceX> = {
      clockIn: time,
      clockInAt: at.toISOString(),
      workMode,
      ...(workMode === 'job-site' ? { jobSite: jobSite.trim() } : {}),
    };
    if (result.kind === 'ok') {
      const verdict = geofenceVerdict(result.lat, result.lng, locations);
      patch = {
        ...patch,
        geoLat: result.lat,
        geoLng: result.lng,
        geoStatus: verdict.status,
        geoPlace: verdict.place,
        geoDistanceM: Math.round(verdict.distanceM),
      };
    } else {
      // Records created while geolocation is unavailable are explicitly flagged.
      patch = { ...patch, geoStatus: 'unavailable' };
    }

    // B1 fix: never clobber an approved leave / rest-day / holiday status with
    // 'present' — attach the clock fields but keep the original day status.
    const preserved = record && PROTECTED_STATUSES.has(record.status) ? record.status : null;

    let recordId: string;
    if (record) {
      update(record.id, preserved ? patch : { ...patch, status: 'present' });
      recordId = record.id;
    } else {
      const created = add({
        employeeId: emp.id,
        date: today,
        shiftId: shift?.id,
        status: 'present',
        otHours: 0,
        otDayType: 'normal',
        otApproved: false,
        ...patch,
      } as Omit<AttendanceX, 'id'>);
      recordId = created.id;
    }
    logAudit({
      actorName: actorName(auth),
      action: 'attendance.clock-in',
      entity: 'attendance',
      entityId: recordId,
      detail:
        `${emp.name} clocked in at ${time}` +
        (workMode === 'job-site' ? ` (job site: ${jobSite.trim()})` : ` (${patch.geoStatus ?? 'unavailable'})`) +
        (preserved ? ` — kept '${preserved}' status` : ''),
    });
    setMessage(
      `Clocked in at ${time}${isLate(time, shift) ? ' — late (past grace period)' : ''}. ` +
        (preserved
          ? `Today is marked as ${preserved.replace('-', ' ')} — that status is kept; contact HR to change it. `
          : '') +
        (result.kind === 'failed' && workMode === 'office'
          ? 'Location unavailable: this record is flagged for HR review.'
          : ''),
    );
  };

  const doClockOut = () => {
    if (!record?.clockIn || record.clockOut) return;
    const time = nowHHmm();
    update(record.id, { clockOut: time, clockOutAt: new Date().toISOString() });
    logAudit({
      actorName: actorName(auth),
      action: 'attendance.clock-out',
      entity: 'attendance',
      entityId: record.id,
      detail: `${emp?.name ?? record.employeeId} clocked out at ${time}`,
    });
    setMessage(`Clocked out at ${time}. Have a good rest!`);
  };

  if (employees.length === 0) {
    return (
      <Card className="rounded-xl">
        <CardContent className="flex items-center gap-3 py-10 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading employees…
        </CardContent>
      </Card>
    );
  }

  const lateNow = record?.clockIn ? isLate(record.clockIn, shift) : false;

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="rounded-xl lg:col-span-3">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock3 className="h-4 w-4 text-amber-600" /> Time clock
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Employee</Label>
              {kiosk ? (
                <Select value={emp?.id ?? ''} onValueChange={setEmployeeId}>
                  <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
                  <SelectContent>
                    {active.map((e) => (
                      <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="flex h-9 items-center rounded-md border bg-muted/50 px-3 text-sm">
                  {emp?.name ?? '—'}
                </div>
              )}
              {!kiosk && (
                <p className="text-xs text-muted-foreground">
                  Clocking in as yourself — kiosk selection is limited to Admin/HR.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label>Work mode</Label>
              <Select value={workMode} onValueChange={(v) => setWorkMode(v as 'office' | 'job-site')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="office">Office / geofenced site</SelectItem>
                  <SelectItem value="job-site">Field staff — job site</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {workMode === 'job-site' && (
            <div className="space-y-2">
              <Label htmlFor="jobsite">Job-site name</Label>
              <Input
                id="jobsite"
                placeholder="e.g. Customer premise — Menara TM, KL"
                value={jobSite}
                onChange={(e) => setJobSite(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                For service staff on customer sites. Geofence checks are skipped; the job-site name is stored with the record.
              </p>
            </div>
          )}

          {!emp && (
            <p className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              Your account is not linked to an employee record — contact HR before clocking in.
            </p>
          )}

          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              size="lg"
              className="h-16 flex-1 gap-2 rounded-xl text-lg"
              onClick={doClockIn}
              disabled={!emp || !!record?.clockIn || geo.kind === 'requesting'}
            >
              {geo.kind === 'requesting' ? <Loader2 className="h-5 w-5 animate-spin" /> : <LogIn className="h-5 w-5" />}
              {record?.clockIn ? `Clocked in ${record.clockIn}` : 'Clock In'}
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="h-16 flex-1 gap-2 rounded-xl text-lg"
              onClick={doClockOut}
              disabled={!record?.clockIn || !!record.clockOut}
            >
              <LogOut className="h-5 w-5" />
              {record?.clockOut ? `Clocked out ${record.clockOut}` : 'Clock Out'}
            </Button>
          </div>

          {message && <p className="text-sm text-muted-foreground">{message}</p>}
          {geo.kind === 'failed' && workMode === 'office' && (
            <p className="flex items-start gap-2 text-xs text-amber-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {geo.reason}. You can still clock in — the record is flagged as “location unavailable” for HR review.
            </p>
          )}

          <div className="rounded-xl bg-muted/60 p-3 text-xs text-muted-foreground">
            <p className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-700" />
              Location is used only to verify presence within an office geofence at clock time. Spoofed or mock
              locations violate company policy and may be flagged for disciplinary review.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-xl lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">Today — {emp?.name.split(' ')[0] ?? '—'}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Shift</span>
            <span className="font-medium">
              {shift ? `${shift.name} · ${shift.startTime}–${shift.endTime}` : 'No shift'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Clock in</span>
            <span className={cn('font-medium', lateNow && 'text-amber-700')}>
              {record?.clockIn ?? '—'} {lateNow && '(late)'}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Clock out</span>
            <span className="font-medium">{record?.clockOut ?? '—'}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">Location</span>
            <GeoBadge record={record} />
          </div>
          <div className="border-t pt-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Geofence sites {isDefault && '(demo defaults)'}</p>
            <ul className="space-y-1.5">
              {locations.map((l) => (
                <li key={l.id} className="flex items-center gap-2 text-xs">
                  <MapPin className="h-3 w-3 text-amber-600" />
                  <span>{l.name}</span>
                  <span className="ml-auto text-muted-foreground">{l.radiusM} m</span>
                </li>
              ))}
            </ul>
            {isDefault && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                Office coordinates are demo defaults — the Settings module can override them via the settings collection.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
