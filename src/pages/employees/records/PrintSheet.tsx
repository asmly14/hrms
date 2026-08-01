/**
 * Personal data sheet — the complete, print-friendly employee file. Renders
 * as a full-screen overlay; a scoped print stylesheet hides the rest of the
 * app so window.print() produces a clean HR-file document. Salary section is
 * included only for Admin/HR viewers.
 */
import { Printer, X } from 'lucide-react';
import {
  DISCIPLINE_TYPE_LABELS,
  SALARY_CHANGE_REASON_LABELS,
  documentExpiryStatus,
  type EmployeeRecordFile,
} from '@/lib/employeeRecords';
import { ageFromDob, fmtDate, fmtRM } from '@/lib/utils';
import type { Employee } from '@/lib/types';
import { Button } from '@/components/ui/button';

function SheetSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5 break-inside-avoid">
      <h2 className="border-b border-stone-300 pb-1 text-sm font-semibold uppercase tracking-wide text-stone-700">
        {title}
      </h2>
      {children}
    </section>
  );
}

function SheetRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <tr className="align-top">
      <td className="w-48 py-1 pr-4 text-xs text-stone-500">{label}</td>
      <td className="py-1 text-sm">{value ?? '—'}</td>
    </tr>
  );
}

function SheetTable({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  if (rows.length === 0) return <p className="py-2 text-xs italic text-stone-400">None recorded.</p>;
  return (
    <table className="mt-2 w-full border-collapse text-sm">
      <thead>
        <tr>
          {head.map((h) => (
            <th
              key={h}
              className="border-b border-stone-300 pb-1 text-left text-xs font-medium text-stone-500"
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((cells, i) => (
          <tr key={i} className="border-b border-stone-200 align-top">
            {cells.map((c, j) => (
              <td key={j} className="py-1.5 pr-3 text-sm">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function PrintSheet({
  employee,
  file,
  department,
  position,
  includeSalary,
  onClose,
}: {
  employee: Employee;
  file: EmployeeRecordFile | undefined;
  department: string;
  position: string;
  /** Admin/HR only — salary history stays out of manager print-outs. */
  includeSalary: boolean;
  onClose: () => void;
}) {
  const print = () => window.print();
  const sorted = <T,>(list: T[] | undefined, by: (x: T) => string | number): T[] =>
    [...(list ?? [])].sort((a, b) => (by(b) > by(a) ? 1 : by(b) < by(a) ? -1 : 0));

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-stone-100">
      {/* Scoped print CSS: hide everything except the sheet. */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #records-print-sheet, #records-print-sheet * { visibility: visible; }
          #records-print-sheet { position: absolute; left: 0; top: 0; width: 100%; margin: 0; padding: 0; box-shadow: none; }
        }
      `}</style>

      {/* Toolbar (screen only) */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-stone-200 bg-white px-4 py-3 print:hidden">
        <p className="text-sm font-medium">Personal data sheet — {employee.name}</p>
        <div className="flex gap-2">
          <Button className="bg-amber-600 text-white hover:bg-amber-700" onClick={print}>
            <Printer className="mr-1.5 h-4 w-4" /> Print
          </Button>
          <Button variant="outline" onClick={onClose}>
            <X className="mr-1.5 h-4 w-4" /> Close
          </Button>
        </div>
      </div>

      <div className="mx-auto my-6 max-w-3xl bg-white p-10 shadow-sm print:my-0">
        <div id="records-print-sheet">
          {/* Header */}
          <header className="border-b-2 border-stone-800 pb-4">
            <h1 className="text-xl font-bold tracking-tight">Employee Personal Data Sheet</h1>
            <p className="mt-1 text-xs text-stone-500">
              {employee.name}
              {employee.employeeNo ? ` · ${employee.employeeNo}` : ''} · generated{' '}
              {fmtDate(new Date().toISOString())} — confidential HR record
            </p>
          </header>

          {/* Core particulars */}
          <SheetSection title="Personal particulars">
            <table className="mt-1 w-full">
              <tbody>
                <SheetRow label="Full name" value={employee.name} />
                <SheetRow label="NRIC / passport no." value={employee.ic} />
                <SheetRow
                  label="Date of birth"
                  value={`${fmtDate(employee.dateOfBirth)} (${ageFromDob(employee.dateOfBirth)} yrs)`}
                />
                <SheetRow label="Gender" value={employee.gender === 'male' ? 'Male' : 'Female'} />
                <SheetRow label="Marital status" value={employee.maritalStatus} />
                <SheetRow label="Children (PCB relief)" value={employee.children} />
                <SheetRow label="Email" value={employee.email} />
                <SheetRow label="Phone" value={employee.phone} />
                <SheetRow label="Work location (state)" value={employee.state} />
                <SheetRow label="Foreign worker" value={employee.isForeignWorker ? 'Yes' : 'No'} />
              </tbody>
            </table>
          </SheetSection>

          <SheetSection title="Employment">
            <table className="mt-1 w-full">
              <tbody>
                <SheetRow label="Department" value={department} />
                <SheetRow label="Position" value={position} />
                <SheetRow label="Employment type" value={employee.employmentType} />
                <SheetRow label="Status" value={employee.status} />
                <SheetRow label="Join date" value={fmtDate(employee.joinDate)} />
                {employee.resignDate && (
                  <SheetRow label="Resignation date" value={fmtDate(employee.resignDate)} />
                )}
                {includeSalary && (
                  <SheetRow label="Base salary" value={`${fmtRM(employee.baseSalary)} / month`} />
                )}
              </tbody>
            </table>
          </SheetSection>

          <SheetSection title="Statutory & bank">
            <table className="mt-1 w-full">
              <tbody>
                <SheetRow label="EPF / KWSP no." value={employee.epfNo || '—'} />
                <SheetRow label="SOCSO no." value={employee.socsoNo || '—'} />
                <SheetRow label="Income tax no." value={employee.taxNo || '—'} />
                <SheetRow label="Bank" value={employee.bankName || '—'} />
                <SheetRow label="Bank account" value={employee.bankAccount || '—'} />
              </tbody>
            </table>
          </SheetSection>

          <SheetSection title="Dependents">
            <SheetTable
              head={['Name', 'Relation', 'Date of birth', 'Child', 'Occupation']}
              rows={(file?.dependents ?? []).map((d) => [
                d.name,
                d.relation,
                d.dob ? fmtDate(d.dob) : '—',
                d.isChild ? 'Yes' : 'No',
                d.occupation ?? '—',
              ])}
            />
          </SheetSection>

          <SheetSection title="Emergency contacts">
            <SheetTable
              head={['Name', 'Relation', 'Phone']}
              rows={(file?.emergencyContacts ?? []).map((c) => [c.name, c.relation, c.phone])}
            />
          </SheetSection>

          <SheetSection title="Academic qualifications">
            <SheetTable
              head={['Level', 'Course', 'Institution', 'Years', 'Grade']}
              rows={sorted(file?.academics, (a) => a.toYear).map((a) => [
                a.level,
                a.course,
                a.institution,
                `${a.fromYear}–${a.toYear}`,
                a.grade ?? '—',
              ])}
            />
          </SheetSection>

          <SheetSection title="Previous employment">
            <SheetTable
              head={['Company', 'Role', 'Period', 'Reason for leaving']}
              rows={sorted(file?.previousEmployment, (p) => p.to).map((p) => [
                p.company,
                p.role,
                `${fmtDate(p.from)} – ${fmtDate(p.to)}`,
                p.reasonForLeaving ?? '—',
              ])}
            />
          </SheetSection>

          <SheetSection title="Documents on file">
            <SheetTable
              head={['Kind', 'File', 'Issued', 'Expiry status']}
              rows={sorted(file?.documents, (d) => d.uploadedAt).map((d) => {
                const ex = documentExpiryStatus(d);
                return [
                  d.kind,
                  d.fileName,
                  d.issueDate ? fmtDate(d.issueDate) : '—',
                  ex.status === 'none'
                    ? '—'
                    : ex.status === 'expired'
                      ? `EXPIRED ${fmtDate(d.expiryDate!)}`
                      : `valid until ${fmtDate(d.expiryDate!)}`,
                ];
              })}
            />
          </SheetSection>

          {includeSalary && (
            <SheetSection title="Salary history">
              <SheetTable
                head={['Effective', 'Previous', 'New', 'Change', 'Reason', 'Approved by']}
                rows={sorted(file?.salaryHistory, (h) => h.effectiveDate).map((h) => [
                  fmtDate(h.effectiveDate),
                  fmtRM(h.previousSalary),
                  fmtRM(h.newSalary),
                  `${h.changePercent > 0 ? '+' : ''}${h.changePercent}%`,
                  SALARY_CHANGE_REASON_LABELS[h.reason],
                  h.approvedBy ?? '—',
                ])}
              />
            </SheetSection>
          )}

          <SheetSection title="Disciplinary record">
            <SheetTable
              head={['Date', 'Type', 'Subject', 'Issued by', 'Acknowledged']}
              rows={sorted(file?.discipline, (d) => d.date).map((d) => [
                fmtDate(d.date),
                DISCIPLINE_TYPE_LABELS[d.type],
                d.subject,
                d.issuedBy,
                d.acknowledgedAt ? fmtDate(d.acknowledgedAt) : 'Pending',
              ])}
            />
          </SheetSection>

          <SheetSection title="Company assets">
            <SheetTable
              head={['Item', 'Serial no.', 'Issued', 'Condition', 'Returned']}
              rows={sorted(file?.assets, (a) => a.issuedAt).map((a) => [
                a.item,
                a.serialNo ?? '—',
                fmtDate(a.issuedAt),
                a.condition,
                a.returnedAt ? fmtDate(a.returnedAt) : 'In custody',
              ])}
            />
          </SheetSection>

          <SheetSection title="Notes">
            <SheetTable
              head={['Date', 'Author', 'Note']}
              rows={sorted(file?.notes, (n) => n.date).map((n) => [fmtDate(n.date), n.author, n.text])}
            />
          </SheetSection>

          <footer className="mt-8 border-t border-stone-300 pt-3 text-[10px] text-stone-400">
            Generated from MY HRMS personnel records · Employment Act 1955 s.61 register ·
            confidential
          </footer>
        </div>
      </div>
    </div>
  );
}
