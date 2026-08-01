/**
 * Contract editor dialog — create / edit both contract kinds.
 * Kind selector cards spell out the Malaysian legal implications; the
 * statutory-applies toggle auto-follows the kind with an override warning.
 *
 * Form state lives in an inner component remounted per open/edit-target
 * (key + Radix unmount-on-close), so state initializes from props without
 * a load effect.
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, Briefcase, ScrollText } from 'lucide-react';
import type { Employee } from '@/lib/types';
import {
  CONTRACT_KIND_INFO,
  REMUNERATION_MODE_LABELS,
  auditContracts,
  statutoryAppliesFor,
  todayISO,
  useContracts,
  type ContractKind,
  type EmploymentContract,
  type RemunerationMode,
} from '@/lib/contracts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: Employee[];
  /** When set, the dialog edits this contract; otherwise it creates a draft. */
  existing: EmploymentContract | null;
  actorName: string;
}

const NONE = '__none';

export default function ContractEditorDialog({
  open,
  onOpenChange,
  employees,
  existing,
  actorName,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <ContractEditorForm
          key={existing?.id ?? 'new'}
          employees={employees}
          existing={existing}
          actorName={actorName}
          onClose={() => onOpenChange(false)}
        />
      )}
    </Dialog>
  );
}

function ContractEditorForm({
  employees,
  existing,
  actorName,
  onClose,
}: {
  employees: Employee[];
  existing: EmploymentContract | null;
  actorName: string;
  onClose: () => void;
}) {
  const { add, update } = useContracts();
  const e = existing; // shorthand for initializers

  const [kind, setKind] = useState<ContractKind>(e?.kind ?? 'of-service');
  const [employeeId, setEmployeeId] = useState(e?.employeeId ?? '');
  const [contractorName, setContractorName] = useState(e?.contractorName ?? '');
  const [contractorIc, setContractorIc] = useState(e?.party.contractorIc ?? '');
  const [companySigner, setCompanySigner] = useState(e?.party.companySigner ?? '');
  const [title, setTitle] = useState(e?.title ?? '');
  const [refNo, setRefNo] = useState(e?.refNo ?? suggestRefNo());
  const [startDate, setStartDate] = useState(e?.startDate ?? todayISO());
  const [indefinite, setIndefinite] = useState(e ? !e.endDate : false);
  const [endDate, setEndDate] = useState(e?.endDate ?? '');
  const [mode, setMode] = useState<RemunerationMode>(e?.remuneration.mode ?? 'monthly-salary');
  const [amount, setAmount] = useState(e ? String(e.remuneration.amount) : '');
  const [currency, setCurrency] = useState(e?.remuneration.currency ?? 'MYR');
  const [probationMonths, setProbationMonths] = useState(
    e?.terms.probationMonths?.toString() ?? '3',
  );
  const [noticeWeeks, setNoticeWeeks] = useState(e?.terms.noticeWeeks?.toString() ?? '4');
  const [workingHours, setWorkingHours] = useState(
    e?.terms.workingHours ?? 'Mon–Fri, 9:00am–6:00pm',
  );
  const [ipClause, setIpClause] = useState(e?.terms.ipClause ?? true);
  const [confidentiality, setConfidentiality] = useState(e?.terms.confidentiality ?? true);
  const [nonCompete, setNonCompete] = useState(e?.terms.nonCompete ?? false);
  const [statutoryApplies, setStatutoryApplies] = useState(
    e?.statutoryApplies ?? statutoryAppliesFor(e?.kind ?? 'of-service'),
  );
  const [activate, setActivate] = useState(e?.status === 'active');
  const [signedAt, setSignedAt] = useState(e?.signedAt ?? '');
  const [signedBy, setSignedBy] = useState(e?.signedBy ?? '');
  const [documentName, setDocumentName] = useState(e?.documentName ?? '');
  const [notes, setNotes] = useState(e?.notes ?? '');

  // Kind drives the statutory toggle (user may still override afterwards).
  function pickKind(k: ContractKind) {
    setKind(k);
    setStatutoryApplies(statutoryAppliesFor(k));
    if (k === 'of-service') setMode('monthly-salary');
    else if (mode === 'monthly-salary') setMode('fixed-fee');
  }

  const statutoryOverridden = statutoryApplies !== statutoryAppliesFor(kind);

  const sortedEmployees = useMemo(
    () => [...employees].sort((a, b) => a.name.localeCompare(b.name)),
    [employees],
  );

  const counterpartyOk = kind === 'of-service' ? employeeId !== '' : contractorName.trim() !== '';
  const valid =
    counterpartyOk &&
    title.trim() !== '' &&
    refNo.trim() !== '' &&
    companySigner.trim() !== '' &&
    startDate !== '' &&
    (indefinite || endDate !== '') &&
    Number.parseFloat(amount) > 0;

  function submit() {
    if (!valid) return;
    const payload = {
      employeeId: kind === 'of-service' ? employeeId : undefined,
      contractorName: kind === 'for-service' ? contractorName.trim() : undefined,
      kind,
      title: title.trim(),
      refNo: refNo.trim(),
      party: {
        companySigner: companySigner.trim(),
        contractorIc: kind === 'for-service' ? contractorIc.trim() || undefined : undefined,
      },
      startDate,
      endDate: indefinite ? undefined : endDate,
      remuneration: { mode, amount: Number.parseFloat(amount), currency: currency.trim() || 'MYR' },
      terms: {
        probationMonths:
          kind === 'of-service' && probationMonths
            ? Number.parseInt(probationMonths, 10)
            : undefined,
        noticeWeeks: noticeWeeks ? Number.parseInt(noticeWeeks, 10) : undefined,
        workingHours: workingHours.trim() || undefined,
        ipClause,
        confidentiality,
        nonCompete,
      },
      statutoryApplies,
      signedAt: signedAt || undefined,
      signedBy: signedBy.trim() || undefined,
      documentName: documentName.trim() || undefined,
      notes: notes.trim() || undefined,
    };

    if (existing) {
      update(existing.id, {
        ...payload,
        // Editorial status only — expiring/expired are derived, renewed/
        // terminated are set by their own workflows.
        status:
          existing.status === 'renewed' || existing.status === 'terminated'
            ? existing.status
            : activate
              ? 'active'
              : 'draft',
      });
      auditContracts('contract.update', existing.id, `${payload.refNo} updated`, actorName);
    } else {
      const created = add({
        ...payload,
        status: activate ? 'active' : 'draft',
        version: 1,
        createdAt: new Date().toISOString(),
      });
      auditContracts(
        'contract.create',
        created.id,
        `${payload.refNo} created (${kind === 'of-service' ? 'of service' : 'for service'})`,
        actorName,
      );
    }
    onClose();
  }

  return (
    <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{existing ? `Edit ${existing.refNo}` : 'New contract'}</DialogTitle>
        <DialogDescription>
          Contract of service = employee under the EA 1955. Contract for service = independent
          contractor engaged for fees.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-5 py-2">
        {/* ── Kind selector cards ── */}
        <div className="grid gap-3 sm:grid-cols-2">
          {(['of-service', 'for-service'] as ContractKind[]).map((k) => {
            const selected = kind === k;
            const info = CONTRACT_KIND_INFO[k];
            return (
              <button
                key={k}
                type="button"
                onClick={() => pickKind(k)}
                className={`rounded-xl border p-3 text-left transition-colors ${
                  selected
                    ? 'border-amber-500 bg-amber-50/70 dark:border-amber-700 dark:bg-amber-950/30'
                    : 'border-stone-200 hover:border-stone-300 dark:border-stone-800 dark:hover:border-stone-700'
                }`}
              >
                <p className="flex items-center gap-2 text-sm font-semibold">
                  {k === 'of-service' ? (
                    <ScrollText className="h-4 w-4 text-amber-700 dark:text-amber-500" />
                  ) : (
                    <Briefcase className="h-4 w-4 text-stone-600 dark:text-stone-400" />
                  )}
                  {k === 'of-service' ? 'Contract OF Service' : 'Contract FOR Service'}
                </p>
                <p className="mt-0.5 text-xs font-medium text-muted-foreground">{info.tagline}</p>
                {selected && (
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                    {info.implications.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
              </button>
            );
          })}
        </div>

        {/* ── Statutory toggle ── */}
        <div className="rounded-xl border border-stone-200 p-3 dark:border-stone-800">
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label htmlFor="ct-statutory" className="text-sm font-medium">
                Statutory coverage applies (EA 1955 · EPF · SOCSO · EIS · PCB/MTD)
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Auto-set from the contract kind.
              </p>
            </div>
            <Switch
              id="ct-statutory"
              checked={statutoryApplies}
              onCheckedChange={setStatutoryApplies}
            />
          </div>
          {statutoryOverridden && (
            <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Override: statutory coverage no longer matches the contract kind. Misclassifying an
              employee as an independent contractor can attract EPF/SOCSO arrears and EA penalties —
              confirm the working arrangement genuinely reflects this.
            </p>
          )}
        </div>

        {/* ── Parties ── */}
        <div className="grid gap-4 sm:grid-cols-2">
          {kind === 'of-service' ? (
            <div className="grid gap-1.5">
              <Label>Employee</Label>
              <Select value={employeeId} onValueChange={setEmployeeId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select employee…" />
                </SelectTrigger>
                <SelectContent>
                  {sortedEmployees.length === 0 && (
                    <SelectItem value={NONE} disabled>
                      No employees found
                    </SelectItem>
                  )}
                  {sortedEmployees.map((emp) => (
                    <SelectItem key={emp.id} value={emp.id}>
                      {emp.name}
                      {emp.employeeNo ? ` · ${emp.employeeNo}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="ct-cname">Contractor / firm name</Label>
                <Input
                  id="ct-cname"
                  value={contractorName}
                  onChange={(ev) => setContractorName(ev.target.value)}
                  placeholder="e.g. Kumar Consulting PLT"
                />
                <p className="text-xs text-muted-foreground">
                  Contractors need not exist in the employee directory.
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ct-cic">Contractor NRIC / business reg no.</Label>
                <Input
                  id="ct-cic"
                  value={contractorIc}
                  onChange={(ev) => setContractorIc(ev.target.value)}
                  placeholder="e.g. 202301012345 (LLP-XXXXXX)"
                />
              </div>
            </>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="ct-signer">Company signatory</Label>
            <Input
              id="ct-signer"
              value={companySigner}
              onChange={(ev) => setCompanySigner(ev.target.value)}
              placeholder="Authorised signatory name"
            />
          </div>
        </div>

        {/* ── Engagement ── */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="ct-title">Engagement title</Label>
            <Input
              id="ct-title"
              value={title}
              onChange={(ev) => setTitle(ev.target.value)}
              placeholder={
                kind === 'of-service' ? 'e.g. Software Engineer' : 'e.g. IT Consultant — ERP rollout'
              }
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ct-ref">Reference no.</Label>
            <Input
              id="ct-ref"
              value={refNo}
              onChange={(ev) => setRefNo(ev.target.value)}
              placeholder="ASM-CT-2025-001"
            />
          </div>
        </div>

        {/* ── Dates ── */}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="ct-start">Start date</Label>
            <Input
              id="ct-start"
              type="date"
              value={startDate}
              onChange={(ev) => setStartDate(ev.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ct-end">End date (fixed-term)</Label>
            <Input
              id="ct-end"
              type="date"
              value={endDate}
              disabled={indefinite}
              onChange={(ev) => setEndDate(ev.target.value)}
            />
          </div>
          <div className="grid content-end gap-1.5 pb-1">
            <div className="flex items-center gap-2">
              <Switch id="ct-indef" checked={indefinite} onCheckedChange={setIndefinite} />
              <Label htmlFor="ct-indef" className="text-sm">
                Indefinite (no end date)
              </Label>
            </div>
          </div>
        </div>

        {/* ── Remuneration ── */}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label>Remuneration mode</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as RemunerationMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(REMUNERATION_MODE_LABELS) as RemunerationMode[]).map((m) => (
                  <SelectItem key={m} value={m}>
                    {REMUNERATION_MODE_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ct-amount">Amount</Label>
            <Input
              id="ct-amount"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(ev) => setAmount(ev.target.value)}
              placeholder="0.00"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ct-ccy">Currency</Label>
            <Input
              id="ct-ccy"
              value={currency}
              onChange={(ev) => setCurrency(ev.target.value)}
              placeholder="MYR"
            />
          </div>
        </div>
        {kind === 'for-service' && (
          <p className="-mt-2 text-xs text-muted-foreground">
            Fees are paid gross against invoices — no EPF, SOCSO, EIS or MTD is deducted. The
            consultant handles their own tax (LHDN CP500 instalments); check whether 2% withholding
            under s.109B ITA 1967 applies to the payee.
          </p>
        )}

        {/* ── Terms ── */}
        <div className="grid gap-4 sm:grid-cols-3">
          {kind === 'of-service' && (
            <div className="grid gap-1.5">
              <Label htmlFor="ct-prob">Probation (months)</Label>
              <Input
                id="ct-prob"
                type="number"
                min="0"
                value={probationMonths}
                onChange={(ev) => setProbationMonths(ev.target.value)}
              />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="ct-notice">Notice period (weeks)</Label>
            <Input
              id="ct-notice"
              type="number"
              min="0"
              value={noticeWeeks}
              onChange={(ev) => setNoticeWeeks(ev.target.value)}
            />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="ct-hours">Working hours / engagement pattern</Label>
            <Input
              id="ct-hours"
              value={workingHours}
              onChange={(ev) => setWorkingHours(ev.target.value)}
              placeholder={
                kind === 'of-service'
                  ? 'Mon–Fri, 9:00am–6:00pm'
                  : 'e.g. Deliverables-based; no fixed hours'
              }
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {(
            [
              ['ipClause', 'IP vests in company', ipClause, setIpClause],
              ['confidentiality', 'Confidentiality / NDA', confidentiality, setConfidentiality],
              ['nonCompete', 'Non-compete restraint', nonCompete, setNonCompete],
            ] as const
          ).map(([id, label, checked, setter]) => (
            <div key={id} className="flex items-center gap-2">
              <Checkbox
                id={`ct-${id}`}
                checked={checked}
                onCheckedChange={(v) => setter(v === true)}
              />
              <Label htmlFor={`ct-${id}`} className="text-sm font-normal">
                {label}
              </Label>
            </div>
          ))}
        </div>

        {/* ── Document & sign-off ── */}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label htmlFor="ct-doc">Signed document (file name)</Label>
            <Input
              id="ct-doc"
              value={documentName}
              onChange={(ev) => setDocumentName(ev.target.value)}
              placeholder="e.g. ASM-CT-2025-001-signed.pdf"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ct-signedat">Counterparty signed on</Label>
            <Input
              id="ct-signedat"
              type="date"
              value={signedAt}
              onChange={(ev) => setSignedAt(ev.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ct-signedby">Signed by</Label>
            <Input
              id="ct-signedby"
              value={signedBy}
              onChange={(ev) => setSignedBy(ev.target.value)}
              placeholder="Counterparty signatory"
            />
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="ct-notes">Notes</Label>
          <Textarea
            id="ct-notes"
            value={notes}
            onChange={(ev) => setNotes(ev.target.value)}
            rows={2}
            placeholder="Internal remarks — renewal intent, special arrangements…"
          />
        </div>

        <div className="flex items-center gap-2">
          <Switch id="ct-active" checked={activate} onCheckedChange={setActivate} />
          <Label htmlFor="ct-active" className="text-sm">
            Mark as active (otherwise saved as draft)
          </Label>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={submit}
          disabled={!valid}
          className="bg-amber-600 text-white hover:bg-amber-700"
        >
          {existing ? 'Save changes' : 'Create contract'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function suggestRefNo(): string {
  const year = new Date().getFullYear();
  const seq = Math.floor(Math.random() * 900) + 100;
  return `CT-${year}-${seq}`;
}
