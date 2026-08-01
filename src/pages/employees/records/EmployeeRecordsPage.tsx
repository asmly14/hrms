/**
 * Employee Records page — /employees/:id/records.
 *
 * The complete personnel file (EA 1955 s.61 register spirit): completeness
 * meter, document-expiry alerts and tabbed sections for dependents,
 * emergency contacts, academics, previous employment, documents, salary
 * history, discipline, assets and notes — plus a print-friendly personal
 * data sheet.
 *
 * Role gating (via useAuth, mirroring EmployeeDetailPage):
 *  - Admin / HR → full read/write, salary tab + salary in print-outs.
 *  - Manager    → read-only, own department only, no salary history.
 *  - Employee   → redirected to the standard detail page.
 */
import { useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, FileWarning, Printer, ShieldCheck, UserX } from 'lucide-react';
import { useAuth } from '@/lib/authContext';
import { useCollection } from '@/lib/db';
import { stateInfo } from '@/lib/holidays';
import {
  expiringDocuments,
  recordCompleteness,
  useEmployeeRecordFiles,
} from '@/lib/employeeRecords';
import { cn, fmtDate } from '@/lib/utils';
import type { Department, Employee, Position } from '@/lib/types';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { EmployeeAvatar } from '../EmployeeAvatar';
import { StatusBadge, TypeBadge } from '../EmployeeBadges';
import { deptName, positionTitle } from '../helpers';
import AcademicsTab from './AcademicsTab';
import AssetsTab from './AssetsTab';
import DependentsTab from './DependentsTab';
import DisciplineTab from './DisciplineTab';
import DocumentsTab from './DocumentsTab';
import EmergencyContactsTab from './EmergencyContactsTab';
import EmploymentHistoryTab from './EmploymentHistoryTab';
import NotesTab from './NotesTab';
import SalaryHistoryTab from './SalaryHistoryTab';
import PrintSheet from './PrintSheet';

function AccessCard({
  icon: Icon,
  title,
  description,
  employeeId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  employeeId?: string;
}) {
  return (
    <Card className="rounded-xl">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon className="h-5 w-5" />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        <Link to={employeeId ? `/employees/${employeeId}` : '/employees'}>
          <Button variant="outline" size="sm">
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            {employeeId ? 'Back to employee' : 'Back to employees'}
          </Button>
        </Link>
      </Empty>
    </Card>
  );
}

export default function EmployeeRecordsPage() {
  const { id } = useParams<{ id: string }>();
  const { role, employeeId, canViewEmployee, user } = useAuth();
  const isHR = role === 'Admin' || role === 'HR';
  const readOnly = !isHR;
  const actorName = user?.username ?? 'HR Admin';

  const { items: employees } = useCollection<Employee>('employees');
  const { items: departments } = useCollection<Department>('departments');
  const { items: positions } = useCollection<Position>('positions');
  const { items: recordFiles } = useEmployeeRecordFiles();

  const [tab, setTab] = useState('dependents');
  const [printOpen, setPrintOpen] = useState(false);

  const emp = employees.find((e) => e.id === id);
  const file = recordFiles.find((f) => f.employeeId === id);

  const completeness = useMemo(() => (emp ? recordCompleteness(emp, file) : null), [emp, file]);
  const docAlerts = useMemo(() => (file ? expiringDocuments([file]) : []), [file]);

  if (!emp) {
    return (
      <AccessCard
        icon={UserX}
        title="Employee not found"
        description="This record may have been removed. Head back to the directory."
      />
    );
  }

  // Employees use the standard detail page; records are an HR surface.
  if (role === 'Employee') {
    return <Navigate to={employeeId ? `/employees/${employeeId}` : '/'} replace />;
  }

  if (!canViewEmployee(emp.id)) {
    return (
      <AccessCard
        icon={ShieldCheck}
        title="No access to this record"
        description="This employee is outside your department."
        employeeId={emp.id}
      />
    );
  }

  const department = deptName(departments, emp.departmentId);
  const position = positionTitle(positions, emp.positionId);
  const expiredCount = docAlerts.filter((d) => d.status === 'expired').length;
  const tabProps = { employee: emp, file, readOnly, actorName };

  const chipTarget: Record<string, () => void> = {
    emergency: () => setTab('emergency'),
    academics: () => setTab('academics'),
    documents: () => setTab('documents'),
  };

  return (
    <div className="space-y-6">
      {/* ── Header: summary card + completeness meter ── */}
      <div className="flex items-start gap-2">
        <Link to={`/employees/${emp.id}`} aria-label="Back to employee">
          <Button variant="ghost" size="icon" className="mt-0.5 shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <Card className="flex-1 rounded-xl">
          <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
            <EmployeeAvatar name={emp.name} size="lg" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <h1 className="truncate text-xl font-semibold tracking-tight">{emp.name}</h1>
              <p className="text-sm text-muted-foreground">
                Personnel records · {position} · {department} · {stateInfo(emp.state).name}
              </p>
              <div className="flex flex-wrap gap-1.5">
                <StatusBadge status={emp.status} />
                <TypeBadge type={emp.employmentType} />
                {readOnly && (
                  <span className="inline-flex items-center rounded-md bg-stone-100 px-2 py-0.5 text-xs text-stone-600">
                    Read-only
                  </span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button variant="outline" onClick={() => setPrintOpen(true)}>
                <Printer className="mr-1.5 h-4 w-4" /> Personal data sheet
              </Button>
            </div>
          </CardContent>

          {/* Completeness meter */}
          {completeness && (
            <div className="border-t border-border/60 px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium">File completeness</p>
                <p
                  className={cn(
                    'text-sm font-semibold',
                    completeness.percent === 100
                      ? 'text-lime-700'
                      : completeness.percent >= 60
                        ? 'text-amber-700'
                        : 'text-red-700',
                  )}
                >
                  {completeness.percent}%
                </p>
              </div>
              <Progress value={completeness.percent} className="mt-2 h-1.5" />
              {completeness.missing.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {completeness.items
                    .filter((i) => !i.ok)
                    .map((i) =>
                      i.section === 'core' ? (
                        <Link key={i.key} to={`/employees/${emp.id}`}>
                          <span className="inline-flex items-center rounded-full bg-red-50 px-2.5 py-1 text-xs text-red-700 transition-colors hover:bg-red-100">
                            {i.label} →
                          </span>
                        </Link>
                      ) : (
                        <button
                          key={i.key}
                          type="button"
                          onClick={chipTarget[i.section]}
                          className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-1 text-xs text-amber-800 transition-colors hover:bg-amber-100"
                        >
                          {i.label} →
                        </button>
                      ),
                    )}
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* ── Document expiry banner ── */}
      {docAlerts.length > 0 && (
        <Alert
          className={cn(
            expiredCount > 0
              ? 'border-red-200 bg-red-50/60 text-red-900 [&>svg]:text-red-700'
              : 'border-amber-200 bg-amber-50/60 text-amber-900 [&>svg]:text-amber-700',
          )}
        >
          <FileWarning className="h-4 w-4" />
          <AlertTitle>
            {expiredCount > 0
              ? `${expiredCount} document${expiredCount === 1 ? '' : 's'} expired`
              : 'Documents expiring soon'}
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-1 space-y-0.5 text-sm">
              {docAlerts.slice(0, 4).map((d) => (
                <li key={d.document.id}>
                  {d.document.kind} — {d.document.fileName}:{' '}
                  {d.status === 'expired'
                    ? `expired ${fmtDate(d.document.expiryDate!)}`
                    : `expires in ${d.daysToExpiry} day${d.daysToExpiry === 1 ? '' : 's'} (${fmtDate(d.document.expiryDate!)})`}
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => setTab('documents')}
              className="mt-2 text-sm font-medium underline underline-offset-4"
            >
              Review documents →
            </button>
          </AlertDescription>
        </Alert>
      )}

      {/* ── Tabbed sections ── */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="dependents">Dependents</TabsTrigger>
          <TabsTrigger value="emergency">Emergency</TabsTrigger>
          <TabsTrigger value="academics">Academic</TabsTrigger>
          <TabsTrigger value="employment">Employment</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          {isHR && <TabsTrigger value="salary">Salary</TabsTrigger>}
          <TabsTrigger value="discipline">Discipline</TabsTrigger>
          <TabsTrigger value="assets">Assets</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
        </TabsList>

        <TabsContent value="dependents" className="mt-4">
          <DependentsTab {...tabProps} />
        </TabsContent>
        <TabsContent value="emergency" className="mt-4">
          <EmergencyContactsTab {...tabProps} />
        </TabsContent>
        <TabsContent value="academics" className="mt-4">
          <AcademicsTab {...tabProps} />
        </TabsContent>
        <TabsContent value="employment" className="mt-4">
          <EmploymentHistoryTab {...tabProps} />
        </TabsContent>
        <TabsContent value="documents" className="mt-4">
          <DocumentsTab {...tabProps} />
        </TabsContent>
        {isHR && (
          <TabsContent value="salary" className="mt-4">
            <SalaryHistoryTab {...tabProps} />
          </TabsContent>
        )}
        <TabsContent value="discipline" className="mt-4">
          <DisciplineTab {...tabProps} />
        </TabsContent>
        <TabsContent value="assets" className="mt-4">
          <AssetsTab {...tabProps} />
        </TabsContent>
        <TabsContent value="notes" className="mt-4">
          <NotesTab {...tabProps} />
        </TabsContent>
      </Tabs>

      {/* ── Print-friendly personal data sheet ── */}
      {printOpen && (
        <PrintSheet
          employee={emp}
          file={file}
          department={department}
          position={position}
          includeSalary={isHR}
          onClose={() => setPrintOpen(false)}
        />
      )}

      {/* Hint when the file has not been opened yet */}
      {!file && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5" />
          No personnel file yet — it is created automatically on the first entry.
        </p>
      )}
    </div>
  );
}
