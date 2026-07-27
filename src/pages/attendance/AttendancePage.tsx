/**
 * Attendance module home — /attendance.
 * Tabs: Clock (geo time clock), Today (live board), Timesheet, Overtime, Anomalies.
 * Entry points are role-aware: shift management is Admin/HR only (Managers get
 * a read-only view); every tab scopes its own data via the auth context.
 */
import { Link } from 'react-router-dom';
import { CalendarClock, Settings2 } from 'lucide-react';
import ClockPanel from './ClockPanel';
import TodayBoard from './TodayBoard';
import TimesheetView from './TimesheetView';
import OTManager from './OTManager';
import AnomalyList from './AnomalyList';
import { isAdminOrHR, useAuthSafe } from './useAuthSafe';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function AttendancePage() {
  const auth = useAuthSafe();
  const canManageShifts = isAdminOrHR(auth);
  // Managers may open the shifts page in read-only mode; Employees may not.
  const canViewShifts = canManageShifts || auth?.role === 'Manager';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <CalendarClock className="h-6 w-6 text-amber-600" /> Attendance
          </h1>
          <p className="text-sm text-muted-foreground">
            Geofenced clock-in, daily board, timesheets and EA 1955-compliant overtime control.
          </p>
        </div>
        {canViewShifts && (
          <Button asChild variant="outline" className="gap-2 rounded-xl">
            <Link to="/attendance/shifts">
              <Settings2 className="h-4 w-4" /> {canManageShifts ? 'Manage shifts' : 'View shifts'}
            </Link>
          </Button>
        )}
      </div>

      <Tabs defaultValue="clock" className="space-y-5">
        <TabsList className="flex h-auto flex-wrap justify-start">
          <TabsTrigger value="clock">Clock In/Out</TabsTrigger>
          <TabsTrigger value="today">Today</TabsTrigger>
          <TabsTrigger value="timesheet">Timesheet</TabsTrigger>
          <TabsTrigger value="ot">Overtime</TabsTrigger>
          <TabsTrigger value="anomalies">Anomalies</TabsTrigger>
        </TabsList>
        <TabsContent value="clock"><ClockPanel /></TabsContent>
        <TabsContent value="today"><TodayBoard /></TabsContent>
        <TabsContent value="timesheet"><TimesheetView /></TabsContent>
        <TabsContent value="ot"><OTManager /></TabsContent>
        <TabsContent value="anomalies"><AnomalyList /></TabsContent>
      </Tabs>
    </div>
  );
}
