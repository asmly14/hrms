/**
 * Contract detail panel — version history chain, renewal / termination
 * workflow, for-service fee payment log, and the printable contract letter.
 */
import { useMemo, useState } from 'react';
import {
  Ban,
  FileText,
  PencilLine,
  RefreshCcw,
  ReceiptText,
  ShieldAlert,
} from 'lucide-react';
import type { Employee } from '@/lib/types';
import {
  CONTRACT_STATUS_LABELS,
  auditContracts,
  contractChain,
  contractStatus,
  feePaymentTotals,
  feePaymentsFor,
  renewContract,
  terminateContract,
  todayISO,
  useFeePayments,
  type EmploymentContract,
} from '@/lib/contracts';
import { fmtDate, fmtRM, round2 } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import ContractDocument from './ContractDocument';
import { kindBadgeClass, remunerationUnit, statusBadgeClass } from './contractBadges';

interface Props {
  contract: EmploymentContract | null;
  contracts: EmploymentContract[];
  employees: Employee[];
  actorName: string;
  onClose: () => void;
  onEdit: (c: EmploymentContract) => void;
  onOpenContract: (id: string) => void;
}

export default function ContractDetailSheet({
  contract,
  contracts,
  employees,
  actorName,
  onClose,
  onEdit,
  onOpenContract,
}: Props) {
  const today = useMemo(() => todayISO(), []);
  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);

  const [terminateOpen, setTerminateOpen] = useState(false);
  const [termDate, setTermDate] = useState(today);
  const [termReason, setTermReason] = useState('');

  const { items: allFees, add: addFee, update: updateFee } = useFeePayments();
  const [feeDate, setFeeDate] = useState(today);
  const [feeRef, setFeeRef] = useState('');
  const [feeAmount, setFeeAmount] = useState('');

  const c = contract;
  const status = c ? contractStatus(c, today) : null;
  const chain = useMemo(() => (c ? contractChain(contracts, c.id) : []), [c, contracts]);
  const fees = useMemo(() => (c ? feePaymentsFor(c.id, allFees) : []), [c, allFees]);
  const totals = useMemo(() => feePaymentTotals(fees), [fees]);

  if (!c || !status) {
    return (
      <Sheet open={false} onOpenChange={() => onClose()}>
        <SheetContent className="hidden" />
      </Sheet>
    );
  }

  const counterparty = c.employeeId
    ? (empById.get(c.employeeId)?.name ?? 'Unknown employee')
    : (c.contractorName ?? '—');
  const counterpartyIc = c.employeeId ? empById.get(c.employeeId)?.ic : c.party.contractorIc;
  const actionable = status === 'active' || status === 'expiring' || status === 'expired';

  function renew() {
    const draft = renewContract(c!.id, actorName, today);
    if (draft) onOpenContract(draft.id);
  }

  function terminate() {
    if (!termDate || !termReason.trim()) return;
    terminateContract(c!.id, termDate, termReason.trim(), actorName);
    setTerminateOpen(false);
    setTermReason('');
  }

  function submitFee() {
    const amount = Number.parseFloat(feeAmount);
    if (!feeDate || !feeRef.trim() || !(amount > 0)) return;
    const created = addFee({
      contractId: c!.id,
      date: feeDate,
      reference: feeRef.trim(),
      amount: round2(amount),
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    auditContracts(
      'contract.fee.add',
      created.id,
      `${c!.refNo} fee ${feeRef.trim()} ${fmtRM(round2(amount))} logged`,
      actorName,
    );
    setFeeRef('');
    setFeeAmount('');
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle className="flex flex-wrap items-center gap-2">
            {c.refNo}
            <Badge variant="secondary" className={kindBadgeClass(c.kind)}>
              {c.kind === 'of-service' ? 'Of Service' : 'For Service'}
            </Badge>
            <Badge variant="secondary" className={statusBadgeClass(status)}>
              {CONTRACT_STATUS_LABELS[status]}
            </Badge>
            {c.version > 1 && <Badge variant="outline">v{c.version}</Badge>}
          </SheetTitle>
          <SheetDescription>
            {counterparty} · {c.title}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-6 pb-10">
          {/* ── Actions ── */}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => onEdit(c)}>
              <PencilLine className="mr-1.5 h-4 w-4" /> Edit
            </Button>
            {actionable && (
              <>
                <Button
                  size="sm"
                  className="bg-amber-600 text-white hover:bg-amber-700"
                  onClick={renew}
                >
                  <RefreshCcw className="mr-1.5 h-4 w-4" /> Renew as v{c.version + 1} draft
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setTerminateOpen(true)}>
                  <Ban className="mr-1.5 h-4 w-4" /> Terminate
                </Button>
              </>
            )}
          </div>

          {!c.statutoryApplies && c.kind === 'of-service' && (
            <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-400">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Statutory coverage has been switched off for this contract of service — verify the
              arrangement does not create EPF/SOCSO/EA exposure.
            </p>
          )}

          {/* ── Key facts ── */}
          <Card className="rounded-xl">
            <CardContent className="grid grid-cols-2 gap-x-4 gap-y-2 p-4 text-sm sm:grid-cols-3">
              <Fact label="Counterparty" value={counterparty} />
              {counterpartyIc && <Fact label="NRIC / reg no." value={counterpartyIc} />}
              <Fact label="Company signatory" value={c.party.companySigner} />
              <Fact
                label="Period"
                value={`${fmtDate(c.startDate)} → ${c.endDate ? fmtDate(c.endDate) : 'indefinite'}`}
              />
              <Fact
                label="Remuneration"
                value={`${fmtRM(c.remuneration.amount)} ${remunerationUnit(c)} ${c.remuneration.currency}`}
              />
              <Fact
                label="Statutory coverage"
                value={c.statutoryApplies ? 'EA 1955 · EPF · SOCSO · EIS · PCB' : 'Not applicable'}
              />
              {c.terms.noticeWeeks != null && (
                <Fact label="Notice" value={`${c.terms.noticeWeeks} weeks`} />
              )}
              {c.terms.probationMonths != null && (
                <Fact label="Probation" value={`${c.terms.probationMonths} months`} />
              )}
              {c.signedAt && (
                <Fact label="Signed" value={`${fmtDate(c.signedAt)} by ${c.signedBy ?? '—'}`} />
              )}
              {c.documentName && <Fact label="Document" value={c.documentName} />}
              {c.terminatedAt && (
                <Fact
                  label="Terminated"
                  value={`${fmtDate(c.terminatedAt)}${c.terminationReason ? ` — ${c.terminationReason}` : ''}`}
                />
              )}
            </CardContent>
          </Card>

          {c.notes && (
            <p className="rounded-xl bg-stone-100 p-3 text-sm text-muted-foreground dark:bg-stone-900">
              {c.notes}
            </p>
          )}

          {/* ── Version chain ── */}
          {chain.length > 1 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold">Version history</h3>
              <ol className="space-y-1.5">
                {chain.map((v, i) => {
                  const vs = contractStatus(v, today);
                  const current = v.id === c.id;
                  return (
                    <li key={v.id}>
                      <button
                        type="button"
                        onClick={() => onOpenContract(v.id)}
                        className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                          current
                            ? 'border-amber-500 bg-amber-50/70 dark:border-amber-700 dark:bg-amber-950/30'
                            : 'border-stone-200 hover:border-stone-300 dark:border-stone-800'
                        }`}
                      >
                        <span className="font-medium">v{v.version}</span>
                        <span className="text-muted-foreground">{v.refNo}</span>
                        <span className="text-xs text-muted-foreground">
                          {fmtDate(v.startDate)} → {v.endDate ? fmtDate(v.endDate) : 'indefinite'}
                        </span>
                        {i < chain.length - 1 && (
                          <span className="text-xs text-muted-foreground">→ renewed</span>
                        )}
                        <Badge variant="secondary" className={`ml-auto ${statusBadgeClass(vs)}`}>
                          {CONTRACT_STATUS_LABELS[vs]}
                        </Badge>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          {/* ── Fee payment log (for-service only) ── */}
          {c.kind === 'for-service' && (
            <div>
              <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                <ReceiptText className="h-4 w-4" /> Fee payment log
              </h3>
              <p className="mb-3 text-xs text-muted-foreground">
                Consultant fees are paid gross against invoices —{' '}
                <strong>no EPF, SOCSO, EIS or MTD deductions apply</strong>. The contractor manages
                their own LHDN CP500 instalments; review s.109B 2% withholding where the payee is a
                resident individual.
              </p>

              {/* add row */}
              <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-[auto_1fr_auto_auto]">
                <Input
                  type="date"
                  value={feeDate}
                  onChange={(e) => setFeeDate(e.target.value)}
                  className="w-full"
                />
                <Input
                  value={feeRef}
                  onChange={(e) => setFeeRef(e.target.value)}
                  placeholder="Deliverable / invoice ref, e.g. INV-2025-014 · Phase 2"
                />
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={feeAmount}
                  onChange={(e) => setFeeAmount(e.target.value)}
                  placeholder="Amount (RM)"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={submitFee}
                  disabled={!feeRef.trim() || !(Number.parseFloat(feeAmount) > 0)}
                >
                  Log fee
                </Button>
              </div>

              {fees.length === 0 ? (
                <p className="rounded-xl border border-dashed border-stone-300 py-6 text-center text-sm text-muted-foreground dark:border-stone-700">
                  <FileText className="mx-auto mb-2 h-6 w-6 text-muted-foreground/50" />
                  No fee payments logged for this engagement yet.
                </p>
              ) : (
                <>
                  <ul className="divide-y divide-stone-200 rounded-xl border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
                    {fees.map((p) => (
                      <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <span className="whitespace-nowrap text-muted-foreground">
                          {fmtDate(p.date)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{p.reference}</span>
                        <span className="font-medium">{fmtRM(p.amount)}</span>
                        <button
                          type="button"
                          title="Toggle paid / pending"
                          onClick={() =>
                            updateFee(p.id, { status: p.status === 'paid' ? 'pending' : 'paid' })
                          }
                        >
                          <Badge
                            variant="secondary"
                            className={
                              p.status === 'paid'
                                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-400'
                                : 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-400'
                            }
                          >
                            {p.status === 'paid' ? 'Paid' : 'Pending'}
                          </Badge>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-2 flex justify-end gap-4 text-sm">
                    <span className="text-muted-foreground">
                      Paid <strong className="text-foreground">{fmtRM(totals.paid)}</strong>
                    </span>
                    <span className="text-muted-foreground">
                      Pending <strong className="text-foreground">{fmtRM(totals.pending)}</strong>
                    </span>
                    <span className="text-muted-foreground">
                      Total <strong className="text-foreground">{fmtRM(totals.total)}</strong>
                    </span>
                  </div>
                </>
              )}
            </div>
          )}

          <Separator />

          {/* ── Printable contract document ── */}
          <div>
            <h3 className="mb-2 text-sm font-semibold">Contract document</h3>
            <ContractDocument contract={c} counterparty={counterparty} counterpartyIc={counterpartyIc} />
          </div>
        </div>

        {/* ── Terminate dialog ── */}
        <Dialog open={terminateOpen} onOpenChange={setTerminateOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Terminate {c.refNo}</DialogTitle>
              <DialogDescription>
                The contract record is kept for audit; its status becomes terminated.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-2">
              <div className="grid gap-1.5">
                <Label htmlFor="term-date">Effective date</Label>
                <Input
                  id="term-date"
                  type="date"
                  value={termDate}
                  onChange={(e) => setTermDate(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="term-reason">Reason</Label>
                <Select value={termReason} onValueChange={setTermReason}>
                  <SelectTrigger id="term-reason">
                    <SelectValue placeholder="Select reason…" />
                  </SelectTrigger>
                  <SelectContent>
                    {[
                      'Mutual separation',
                      'Resignation',
                      'Breach of contract',
                      'Project completed / scope ended',
                      'Non-performance',
                      'Redundancy / retrenchment',
                      'Other',
                    ].map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setTerminateOpen(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={terminate} disabled={!termDate || !termReason}>
                Terminate contract
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-medium">{value}</p>
    </div>
  );
}
