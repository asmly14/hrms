/**
 * Statutory outputs for a payroll run: EPF Form A, SOCSO Borang 8A, EIS (SIP),
 * CP39 (PCB) and HRD levy summaries, each with totals and a CSV download,
 * plus the bank giro salary-credit file (CSV / TXT).
 *
 * Wage bases mirror payrollEngine: EPF/HRD base = basic + fixed allowances,
 * SOCSO/EIS base = gross incl. OT. Amounts come straight from the stored
 * payslips — no rate is recomputed here.
 */
import { AlertTriangle, Download, Landmark } from 'lucide-react';
import type { Employee, PayrollRun, Payslip, Settings } from '@/lib/types';
import { fmtRM, round2 } from '@/lib/utils';
import { downloadTextFile, monthLabel, num2, toCsv } from './helpers';
import { FormHeader, Money } from './components';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

interface Props {
  run: PayrollRun;
  slips: Payslip[];
  empMap: Map<string, Employee>;
  settings?: Settings;
}

const epfBase = (p: Payslip) => round2(p.basicPay + p.allowances);

export default function StatutoryOutputs({ run, slips, empMap, settings }: Props) {
  const name = (p: Payslip) => empMap.get(p.employeeId)?.name ?? p.employeeId;
  const epfNo = (p: Payslip) => empMap.get(p.employeeId)?.epfNo ?? '—';
  const socsoNo = (p: Payslip) => empMap.get(p.employeeId)?.socsoNo ?? '—';
  const ic = (p: Payslip) => empMap.get(p.employeeId)?.ic ?? '—';
  const taxNo = (p: Payslip) => empMap.get(p.employeeId)?.taxNo ?? '—';
  const mk = run.monthKey;

  const sum = (fn: (p: Payslip) => number) => round2(slips.reduce((s, p) => s + fn(p), 0));

  // B6 — employees without bank details would ship blank giro fields.
  const missingBank = slips.filter((p) => {
    const e = empMap.get(p.employeeId);
    return !e?.bankName || !e?.bankAccount;
  });

  const dl = (file: string, rows: (string | number)[][]) =>
    downloadTextFile(`${file}-${mk}.csv`, toCsv(rows));

  return (
    <div className="space-y-6">
      {/* ── EPF Form A ─────────────────────────────────────────── */}
      <Card className="rounded-xl">
        <CardHeader>
          <FormHeader
            title="EPF Form A (Borang A) — KWSP contribution listing"
            subtitle={`Employer EPF no. ${settings?.epfEmployerNo ?? '—'} · due by the 15th of the following month via e-Caruman / i-Akaun Majikan.`}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  dl('epf-form-a', [
                    ['No', 'Employee Name', 'EPF No', 'Wages (RM)', 'Employee Share (RM)', 'Employer Share (RM)', 'Total (RM)'],
                    ...slips.map((p, i) => [
                      i + 1, name(p), epfNo(p), num2(epfBase(p)),
                      num2(p.epfEmployee), num2(p.epfEmployer), num2(round2(p.epfEmployee + p.epfEmployer)),
                    ]),
                    ['', 'TOTAL', '', num2(sum(epfBase)), num2(sum((p) => p.epfEmployee)), num2(sum((p) => p.epfEmployer)), num2(sum((p) => p.epfEmployee + p.epfEmployer))],
                  ])
                }
              >
                <Download className="h-4 w-4" /> CSV
              </Button>
            }
          />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">No</TableHead>
                <TableHead>Employee</TableHead>
                <TableHead>EPF no.</TableHead>
                <TableHead className="text-right">Wages</TableHead>
                <TableHead className="text-right">Employee share</TableHead>
                <TableHead className="text-right">Employer share</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {slips.map((p, i) => (
                <TableRow key={p.id}>
                  <TableCell>{i + 1}</TableCell>
                  <TableCell className="font-medium">{name(p)}</TableCell>
                  <TableCell className="text-muted-foreground">{epfNo(p)}</TableCell>
                  <TableCell className="text-right"><Money>{fmtRM(epfBase(p))}</Money></TableCell>
                  <TableCell className="text-right"><Money>{fmtRM(p.epfEmployee)}</Money></TableCell>
                  <TableCell className="text-right"><Money>{fmtRM(p.epfEmployer)}</Money></TableCell>
                  <TableCell className="text-right"><Money>{fmtRM(p.epfEmployee + p.epfEmployer)}</Money></TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={3}>Total</TableCell>
                <TableCell className="text-right"><Money>{fmtRM(sum(epfBase))}</Money></TableCell>
                <TableCell className="text-right"><Money>{fmtRM(sum((p) => p.epfEmployee))}</Money></TableCell>
                <TableCell className="text-right"><Money>{fmtRM(sum((p) => p.epfEmployer))}</Money></TableCell>
                <TableCell className="text-right"><Money>{fmtRM(sum((p) => p.epfEmployee + p.epfEmployer))}</Money></TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>

      {/* ── SOCSO Borang 8A ────────────────────────────────────── */}
      <Card className="rounded-xl">
        <CardHeader>
          <FormHeader
            title="SOCSO Borang 8A — PERKESO contribution listing"
            subtitle={`Employer SOCSO no. ${settings?.socsoEmployerNo ?? '—'} · due by the 15th via the PERKESO ASSIST portal.`}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  dl('socso-borang-8a', [
                    ['No', 'Employee Name', 'NRIC', 'SOCSO No', 'Category', 'Wages (RM)', 'Employee (RM)', 'Employer (RM)', 'Total (RM)'],
                    ...slips.map((p, i) => [
                      i + 1, name(p), ic(p), socsoNo(p), `Cat ${p.socsoCategory}`, num2(p.grossPay),
                      num2(p.socsoEmployee), num2(p.socsoEmployer), num2(round2(p.socsoEmployee + p.socsoEmployer)),
                    ]),
                    ['', 'TOTAL', '', '', '', num2(sum((p) => p.grossPay)), num2(sum((p) => p.socsoEmployee)), num2(sum((p) => p.socsoEmployer)), num2(sum((p) => p.socsoEmployee + p.socsoEmployer))],
                  ])
                }
              >
                <Download className="h-4 w-4" /> CSV
              </Button>
            }
          />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">No</TableHead>
                <TableHead>Employee</TableHead>
                <TableHead>SOCSO no.</TableHead>
                <TableHead>Cat.</TableHead>
                <TableHead className="text-right">Wages</TableHead>
                <TableHead className="text-right">Employee</TableHead>
                <TableHead className="text-right">Employer</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {slips.map((p, i) => (
                <TableRow key={p.id}>
                  <TableCell>{i + 1}</TableCell>
                  <TableCell className="font-medium">{name(p)}</TableCell>
                  <TableCell className="text-muted-foreground">{socsoNo(p)}</TableCell>
                  <TableCell>{p.socsoCategory}</TableCell>
                  <TableCell className="text-right"><Money>{fmtRM(p.grossPay)}</Money></TableCell>
                  <TableCell className="text-right"><Money>{fmtRM(p.socsoEmployee)}</Money></TableCell>
                  <TableCell className="text-right"><Money>{fmtRM(p.socsoEmployer)}</Money></TableCell>
                  <TableCell className="text-right"><Money>{fmtRM(p.socsoEmployee + p.socsoEmployer)}</Money></TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={4}>Total</TableCell>
                <TableCell className="text-right"><Money>{fmtRM(sum((p) => p.grossPay))}</Money></TableCell>
                <TableCell className="text-right"><Money>{fmtRM(sum((p) => p.socsoEmployee))}</Money></TableCell>
                <TableCell className="text-right"><Money>{fmtRM(sum((p) => p.socsoEmployer))}</Money></TableCell>
                <TableCell className="text-right"><Money>{fmtRM(sum((p) => p.socsoEmployee + p.socsoEmployer))}</Money></TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>

      {/* ── EIS / SIP ──────────────────────────────────────────── */}
      <Card className="rounded-xl">
        <CardHeader>
          <FormHeader
            title="EIS (SIP) contribution summary — Act 800"
            subtitle="Employment Insurance System, remitted together with SOCSO via the ASSIST portal."
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  dl('eis-sip', [
                    ['No', 'Employee Name', 'NRIC', 'Wages (RM)', 'Employee (RM)', 'Employer (RM)', 'Total (RM)'],
                    ...slips.map((p, i) => [
                      i + 1, name(p), ic(p), num2(p.grossPay),
                      num2(p.eisEmployee), num2(p.eisEmployer), num2(round2(p.eisEmployee + p.eisEmployer)),
                    ]),
                    ['', 'TOTAL', '', num2(sum((p) => p.grossPay)), num2(sum((p) => p.eisEmployee)), num2(sum((p) => p.eisEmployer)), num2(sum((p) => p.eisEmployee + p.eisEmployer))],
                  ])
                }
              >
                <Download className="h-4 w-4" /> CSV
              </Button>
            }
          />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">No</TableHead>
                <TableHead>Employee</TableHead>
                <TableHead>NRIC</TableHead>
                <TableHead className="text-right">Wages</TableHead>
                <TableHead className="text-right">Employee</TableHead>
                <TableHead className="text-right">Employer</TableHead>
                <TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {slips.map((p, i) => (
                <TableRow key={p.id}>
                  <TableCell>{i + 1}</TableCell>
                  <TableCell className="font-medium">{name(p)}</TableCell>
                  <TableCell className="text-muted-foreground">{ic(p)}</TableCell>
                  <TableCell className="text-right"><Money>{fmtRM(p.grossPay)}</Money></TableCell>
                  <TableCell className="text-right"><Money>{fmtRM(p.eisEmployee)}</Money></TableCell>
                  <TableCell className="text-right"><Money>{fmtRM(p.eisEmployer)}</Money></TableCell>
                  <TableCell className="text-right"><Money>{fmtRM(p.eisEmployee + p.eisEmployer)}</Money></TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={3}>Total</TableCell>
                <TableCell className="text-right"><Money>{fmtRM(sum((p) => p.grossPay))}</Money></TableCell>
                <TableCell className="text-right"><Money>{fmtRM(sum((p) => p.eisEmployee))}</Money></TableCell>
                <TableCell className="text-right"><Money>{fmtRM(sum((p) => p.eisEmployer))}</Money></TableCell>
                <TableCell className="text-right"><Money>{fmtRM(sum((p) => p.eisEmployee + p.eisEmployer))}</Money></TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>

      {/* ── CP39 / PCB ─────────────────────────────────────────── */}
      <Card className="rounded-xl">
        <CardHeader>
          <FormHeader
            title="CP39 — monthly tax deduction (PCB/MTD) remittance"
            subtitle={`Employer tax no. ${settings?.taxEmployerNo ?? '—'} · remit to LHDN by the 15th via MyTax e-CP39 / e-Data PCB.`}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  dl('cp39-pcb', [
                    ['No', 'Employee Name', 'NRIC', 'Income Tax No', 'Taxable Remuneration (RM)', 'PCB (RM)'],
                    ...slips.map((p, i) => [i + 1, name(p), ic(p), taxNo(p), num2(p.grossPay), num2(p.pcb)]),
                    ['', 'TOTAL', '', '', num2(sum((p) => p.grossPay)), num2(sum((p) => p.pcb))],
                  ])
                }
              >
                <Download className="h-4 w-4" /> CSV
              </Button>
            }
          />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">No</TableHead>
                <TableHead>Employee</TableHead>
                <TableHead>Income tax no.</TableHead>
                <TableHead className="text-right">Taxable remuneration</TableHead>
                <TableHead className="text-right">PCB</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {slips.map((p, i) => (
                <TableRow key={p.id}>
                  <TableCell>{i + 1}</TableCell>
                  <TableCell className="font-medium">{name(p)}</TableCell>
                  <TableCell className="text-muted-foreground">{taxNo(p)}</TableCell>
                  <TableCell className="text-right"><Money>{fmtRM(p.grossPay)}</Money></TableCell>
                  <TableCell className="text-right"><Money>{fmtRM(p.pcb)}</Money></TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={3}>Total</TableCell>
                <TableCell className="text-right"><Money>{fmtRM(sum((p) => p.grossPay))}</Money></TableCell>
                <TableCell className="text-right"><Money>{fmtRM(sum((p) => p.pcb))}</Money></TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>

      {/* ── HRD levy ───────────────────────────────────────────── */}
      <Card className="rounded-xl">
        <CardHeader>
          <FormHeader
            title="HRD Corp levy — PSMB Act 2001"
            subtitle="Levy base = basic + fixed allowances (OT/bonus excluded). Employer-only; remitted via the HRD Corp portal."
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  dl('hrd-levy', [
                    ['No', 'Employee Name', 'Levy Base (RM)', 'HRD Levy (RM)'],
                    ...slips.map((p, i) => [i + 1, name(p), num2(epfBase(p)), num2(p.hrdLevy)]),
                    ['', 'TOTAL', num2(sum(epfBase)), num2(sum((p) => p.hrdLevy))],
                  ])
                }
              >
                <Download className="h-4 w-4" /> CSV
              </Button>
            }
          />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">No</TableHead>
                <TableHead>Employee</TableHead>
                <TableHead className="text-right">Levy base</TableHead>
                <TableHead className="text-right">HRD levy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {slips.map((p, i) => (
                <TableRow key={p.id}>
                  <TableCell>{i + 1}</TableCell>
                  <TableCell className="font-medium">{name(p)}</TableCell>
                  <TableCell className="text-right"><Money>{fmtRM(epfBase(p))}</Money></TableCell>
                  <TableCell className="text-right"><Money>{fmtRM(p.hrdLevy)}</Money></TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={2}>Total</TableCell>
                <TableCell className="text-right"><Money>{fmtRM(sum(epfBase))}</Money></TableCell>
                <TableCell className="text-right"><Money>{fmtRM(sum((p) => p.hrdLevy))}</Money></TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>

      {/* ── Bank giro ──────────────────────────────────────────── */}
      <Card className="rounded-xl">
        <CardHeader>
          <FormHeader
            title="Bank giro salary credit file"
            subtitle={`Salary disbursement by bank transfer (EA 1955 s.25) for ${monthLabel(mk)} — one line per employee.`}
            action={
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    dl('bank-giro', [
                      ['Bank Name', 'Account Number', 'Employee Name', 'NRIC', 'Amount (RM)', 'Reference'],
                      ...slips.map((p) => {
                        const e = empMap.get(p.employeeId);
                        return [e?.bankName ?? '', e?.bankAccount ?? '', name(p), ic(p), num2(p.netPay), `SALARY ${mk}`];
                      }),
                      ['', '', 'TOTAL', '', num2(sum((p) => p.netPay)), ''],
                    ])
                  }
                >
                  <Download className="h-4 w-4" /> CSV
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const lines = [
                      `H|${settings?.companyName ?? 'EMPLOYER'}|${settings?.companyRegNo ?? ''}|${mk}|${num2(sum((p) => p.netPay))}`,
                      ...slips.map((p, i) => {
                        const e = empMap.get(p.employeeId);
                        return `D|${i + 1}|${e?.bankName ?? ''}|${e?.bankAccount ?? ''}|${name(p)}|${ic(p)}|${num2(p.netPay)}`;
                      }),
                      `T|${slips.length}|${num2(sum((p) => p.netPay))}`,
                    ];
                    downloadTextFile(`bank-giro-${mk}.txt`, lines.join('\r\n'), 'text/plain');
                  }}
                >
                  <Download className="h-4 w-4" /> TXT
                </Button>
              </div>
            }
          />
        </CardHeader>
        <CardContent>
          {missingBank.length > 0 && (
            <Alert className="mb-4 border-amber-300 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-950/30">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <AlertTitle className="text-amber-800 dark:text-amber-500">
                {missingBank.length} employee(s) missing bank details
              </AlertTitle>
              <AlertDescription className="text-xs text-muted-foreground">
                {missingBank.map((p) => name(p)).join(', ')} — the exported giro file will
                contain empty bank name / account fields for them. Fill in their bank details
                before disbursing.
              </AlertDescription>
            </Alert>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">No</TableHead>
                <TableHead>Employee</TableHead>
                <TableHead>Bank</TableHead>
                <TableHead>Account no.</TableHead>
                <TableHead className="text-right">Net pay</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {slips.map((p, i) => {
                const e = empMap.get(p.employeeId);
                const bankMissing = !e?.bankName || !e?.bankAccount;
                return (
                  <TableRow key={p.id}>
                    <TableCell>{i + 1}</TableCell>
                    <TableCell className="font-medium">
                      {name(p)}
                      {bankMissing && (
                        <Badge variant="outline" className="ml-2 border-amber-400 text-amber-700 dark:text-amber-500">
                          Missing bank details
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{e?.bankName ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{e?.bankAccount ?? '—'}</TableCell>
                    <TableCell className="text-right"><Money>{fmtRM(p.netPay)}</Money></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={4}>
                  <span className="inline-flex items-center gap-1.5">
                    <Landmark className="h-3.5 w-3.5" /> Total to disburse
                  </span>
                </TableCell>
                <TableCell className="text-right"><Money>{fmtRM(sum((p) => p.netPay))}</Money></TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
