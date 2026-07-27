/**
 * Attendance module — shared model helpers.
 *
 * Contract gaps handled here (reported, not changed in src/lib):
 *  - `Settings` has no office-location/geofence fields → we read the singleton
 *    tolerantly (`SettingsX.officeLocations`) and fall back to demo defaults.
 *  - `AttendanceRecord` has no geo/job-site/timestamp fields → we persist an
 *    extended shape (`AttendanceX`) into the same 'attendance' collection.
 *    Core fields stay exactly per contract so payrollEngine keeps working.
 *  - `Shift` has no graceMinutes / employee assignment fields → extended via
 *    `ShiftX` in the same 'shifts' collection.
 *  - No OT-request collection → an OT request is an attendance record with
 *    `otRequested: true, otApproved: false`; approval flips `otApproved`,
 *    which is the exact field payrollEngine pays on.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import type {
  AttendanceRecord, Employee, OTDayType, Settings, Shift,
} from '@/lib/types';
import { isHoliday, isWeekend, stateInfo } from '@/lib/holidays';

// ── Extended (module-local) shapes ───────────────────────────────────────────

export interface OfficeLocation {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
}

export type SettingsX = Settings & { officeLocations?: OfficeLocation[] };

export type GeoStatus = 'inside' | 'outside' | 'unavailable';

export type AttendanceX = AttendanceRecord & {
  /** Full ISO timestamps (contract only carries 'HH:mm'). */
  clockInAt?: string;
  clockOutAt?: string;
  geoLat?: number;
  geoLng?: number;
  geoStatus?: GeoStatus;
  geoPlace?: string; // nearest office name / '—'
  geoDistanceM?: number;
  workMode?: 'office' | 'job-site';
  jobSite?: string;
  /** OT request workflow (pending → approved via otApproved, or otRejected). */
  otRequested?: boolean;
  otRejected?: boolean;
  otRequestReason?: string;
};

export type ShiftX = Shift & {
  graceMinutes?: number; // late grace (default 10)
  employeeIds?: string[]; // fixed assignment
};

/** Demo fallback — used only because Settings has no officeLocations field yet. */
export const DEFAULT_OFFICE_LOCATIONS: OfficeLocation[] = [
  { id: 'hq-kl', name: 'HQ — Menara ASM, Jalan Sultan Ismail, KL', lat: 3.1539, lng: 101.711, radiusM: 300 },
  { id: 'ops-shah-alam', name: 'Ops Hub — Shah Alam, Selangor', lat: 3.0738, lng: 101.5183, radiusM: 500 },
];

export function officeLocationsOf(settings: SettingsX | undefined): { locations: OfficeLocation[]; isDefault: boolean } {
  if (settings?.officeLocations && settings.officeLocations.length > 0) {
    return { locations: settings.officeLocations, isDefault: false };
  }
  return { locations: DEFAULT_OFFICE_LOCATIONS, isDefault: true };
}

/** Loose shape of the core helper module added in Wave 2 (lib/appSettings.ts). */
type AppSettingsModule = { getOfficeLocations?: () => unknown };

/**
 * Resolve geofence office locations. Prefers the core `getOfficeLocations()`
 * helper from `@/lib/appSettings` once that module exists (added by the core
 * agent this wave); falls back to the settings collection, then to demo
 * defaults. The glob import resolves to an empty map while the file is
 * absent, so this compiles and runs cleanly in both worlds.
 */
export function useOfficeLocations(
  settings: SettingsX | undefined,
): { locations: OfficeLocation[]; isDefault: boolean } {
  const [fromCore, setFromCore] = useState<OfficeLocation[] | null>(null);

  useEffect(() => {
    let alive = true;
    const loaders = import.meta.glob<AppSettingsModule>('../../lib/appSettings.ts');
    const load = loaders['../../lib/appSettings.ts'];
    if (load) {
      load()
        .then((mod) => {
          if (!alive || typeof mod.getOfficeLocations !== 'function') return;
          const raw = mod.getOfficeLocations();
          if (!Array.isArray(raw)) return;
          const locs = raw.filter(
            (l): l is OfficeLocation =>
              !!l &&
              typeof l === 'object' &&
              typeof (l as OfficeLocation).lat === 'number' &&
              typeof (l as OfficeLocation).lng === 'number' &&
              typeof (l as OfficeLocation).radiusM === 'number',
          );
          if (locs.length > 0) {
            setFromCore(
              locs.map((l, i) => ({
                id: String(l.id ?? `office-${i}`),
                name: String(l.name ?? 'Office'),
                lat: l.lat,
                lng: l.lng,
                radiusM: l.radiusM,
              })),
            );
          }
        })
        .catch(() => {
          /* helper unavailable or failed — keep the fallback */
        });
    }
    return () => {
      alive = false;
    };
  }, []);

  if (fromCore && fromCore.length > 0) return { locations: fromCore, isDefault: false };
  return officeLocationsOf(settings);
}

// ── Geo helpers ──────────────────────────────────────────────────────────────

/** Great-circle distance in metres (haversine). */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export interface GeoVerdict {
  status: 'inside' | 'outside';
  place: string;
  distanceM: number;
}

/** Nearest office + inside/outside verdict for a coordinate. */
export function geofenceVerdict(lat: number, lng: number, locations: OfficeLocation[]): GeoVerdict {
  let best: GeoVerdict = { status: 'outside', place: '—', distanceM: Infinity };
  for (const loc of locations) {
    const d = haversineM(lat, lng, loc.lat, loc.lng);
    if (d < best.distanceM) best = { status: d <= loc.radiusM ? 'inside' : 'outside', place: loc.name, distanceM: d };
  }
  return best;
}

// ── Time helpers ─────────────────────────────────────────────────────────────

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function nowHHmm(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Worked hours between clock-in/out, minus break; handles overnight shifts. */
export function workedHours(clockIn?: string, clockOut?: string, breakMinutes = 0): number {
  if (!clockIn || !clockOut) return 0;
  let diff = hhmmToMin(clockOut) - hhmmToMin(clockIn);
  // B5 fix: strictly-negative only — identical in/out is 0h, not 24h.
  if (diff < 0) diff += 1440; // crosses midnight
  return Math.max(0, (diff - breakMinutes) / 60);
}

/** Late when clock-in is past shift start + grace minutes (default 10). */
export function isLate(clockIn: string | undefined, shift: ShiftX | undefined): boolean {
  if (!clockIn || !shift) return false;
  return hhmmToMin(clockIn) > hhmmToMin(shift.startTime) + (shift.graceMinutes ?? 10);
}

/** Shift duration in hours (net of break). */
export function shiftHours(shift: Shift): number {
  let diff = hhmmToMin(shift.endTime) - hhmmToMin(shift.startTime);
  if (diff <= 0) diff += 1440;
  return Math.max(0, (diff - shift.breakMinutes) / 60);
}

/** Shift end as minutes-of-day on the work date (overnight shifts → >1440). */
export function shiftEndMin(shift: ShiftX): number {
  const start = hhmmToMin(shift.startTime);
  let end = hhmmToMin(shift.endTime);
  if (end <= start) end += 1440; // overnight shift ends after midnight
  return end;
}

// ── Shift resolution ─────────────────────────────────────────────────────────

/** Rotation plan: members cycle through `shiftIds`, `weeksEach` weeks per shift. */
export interface RotationPlan {
  id: string;
  name: string;
  shiftIds: string[];
  weeksEach: number;
  anchorDate: string; // ISO date — week 0 starts here
  employeeIds: string[];
}

const ROT_KEY = 'myhrms:attendance:rotations';
const rotListeners = new Set<() => void>();

export function getRotations(): RotationPlan[] {
  try {
    const raw = localStorage.getItem(ROT_KEY);
    return raw ? (JSON.parse(raw) as RotationPlan[]) : [];
  } catch {
    return [];
  }
}

export function saveRotations(plans: RotationPlan[]): void {
  localStorage.setItem(ROT_KEY, JSON.stringify(plans));
  rotListeners.forEach((fn) => fn());
}

export function useRotations(): RotationPlan[] {
  const raw = useSyncExternalStore(
    (fn) => {
      rotListeners.add(fn);
      return () => rotListeners.delete(fn);
    },
    () => localStorage.getItem(ROT_KEY) ?? '',
  );
  try {
    return raw ? (JSON.parse(raw) as RotationPlan[]) : [];
  } catch {
    return [];
  }
}

/** Seed heuristic (mirrors seed.ts) so the module works before any assignment. */
function seedShiftFallback(emp: Employee, shifts: ShiftX[]): ShiftX | undefined {
  const normal = shifts.find((s) => s.id === 'shift-normal') ?? shifts[0];
  if (emp.departmentId === 'dept-cs') return shifts.find((s) => s.id === 'shift-support') ?? normal;
  if (emp.departmentId === 'dept-ops' && emp.positionId === 'pos-tech') {
    return shifts.find((s) => s.id === (emp.id === 'emp-21' ? 'shift-svc-a' : 'shift-svc-b')) ?? normal;
  }
  return normal;
}

/** Effective shift for an employee on a date: rotation → fixed assignment → seed fallback. */
export function shiftForEmployee(
  emp: Employee,
  shifts: ShiftX[],
  rotations: RotationPlan[],
  dateISO: string,
): ShiftX | undefined {
  for (const plan of rotations) {
    if (!plan.employeeIds.includes(emp.id) || plan.shiftIds.length === 0) continue;
    const days = Math.floor((Date.parse(`${dateISO}T00:00:00`) - Date.parse(`${plan.anchorDate}T00:00:00`)) / 86_400_000);
    if (days < 0) continue;
    const weeks = Math.floor(days / 7);
    const idx = Math.floor(weeks / Math.max(1, plan.weeksEach)) % plan.shiftIds.length;
    const shift = shifts.find((s) => s.id === plan.shiftIds[idx]);
    if (shift) return shift;
  }
  const fixed = shifts.find((s) => (s.employeeIds ?? []).includes(emp.id));
  return fixed ?? seedShiftFallback(emp, shifts);
}

/** Is the employee scheduled to work on that date (per shift workDays / part-time rule)? */
export function isScheduledWorkDay(emp: Employee, shift: ShiftX | undefined, dateISO: string): boolean {
  const dow = new Date(`${dateISO}T00:00:00`).getDay();
  if (emp.employmentType === 'part-time') {
    // B8 fix: prefer the assigned shift's work days; Mon/Wed/Fri is only a fallback.
    return shift ? shift.workDays.includes(dow) : [1, 3, 5].includes(dow);
  }
  return shift ? shift.workDays.includes(dow) : dow >= 1 && dow <= 5;
}

/** Auto-detect OT day type: holiday → rest → normal (EA 1955). */
export function otDayTypeFor(emp: Employee, shift: ShiftX | undefined, dateISO: string): OTDayType {
  if (isHoliday(dateISO, emp.state)) return 'holiday';
  const dow = new Date(`${dateISO}T00:00:00`).getDay();
  if (shift && shift.restDay === dow) return 'rest';
  if (!isScheduledWorkDay(emp, shift, dateISO)) return 'rest';
  return 'normal';
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function restDayHint(stateCode: Employee['state']): string {
  const info = stateInfo(stateCode);
  return info.weekend === 'fri-sat'
    ? `${info.name} observes a Fri–Sat weekend — Friday is the common weekly rest day.`
    : `${info.name} observes a Sat–Sun weekend — Sunday is the common weekly rest day.`;
}

export function isRestOrHoliday(emp: Employee, shift: ShiftX | undefined, dateISO: string): boolean {
  if (isHoliday(dateISO, emp.state)) return true;
  if (isWeekend(dateISO, emp.state) && !isScheduledWorkDay(emp, shift, dateISO)) return true;
  return shift ? shift.restDay === new Date(`${dateISO}T00:00:00`).getDay() : false;
}
