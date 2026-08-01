/**
 * Print-friendly contract document — generates a formatted Contract of
 * Service / Contract for Service letter from the stored data, with the
 * active company as letterhead. The Print button triggers window.print();
 * the scoped <style> block isolates the letter for print output.
 */
import { Printer } from 'lucide-react';
import { getActiveCompany } from '@/lib/db';
import {
  CONTRACT_KIND_LABELS,
  REMUNERATION_MODE_LABELS,
  type EmploymentContract,
} from '@/lib/contracts';
import { fmtDate, fmtRM } from '@/lib/utils';
import { Button } from '@/components/ui/button';

interface Props {
  contract: EmploymentContract;
  /** Resolved counterparty display name (employee name or contractor name). */
  counterparty: string;
  counterpartyIc?: string;
}

export default function ContractDocument({ contract: c, counterparty, counterpartyIc }: Props) {
  const company = getActiveCompany();
  const companyName = company?.name ?? 'The Company';
  const companyReg = company?.regNo ? ` (Reg. No. ${company.regNo})` : '';
  const isOfService = c.kind === 'of-service';
  const ref = c.refNo;
  const remunerationLine = `${c.remuneration.currency} ${fmtRM(c.remuneration.amount).replace(/^RM\s?/, '')} ${
    c.remuneration.mode === 'monthly-salary'
      ? 'per month'
      : c.remuneration.mode === 'daily'
        ? 'per day'
        : c.remuneration.mode === 'hourly'
          ? 'per hour'
          : c.remuneration.mode === 'fixed-fee'
            ? 'as a fixed fee for the engagement'
            : 'per deliverable accepted'
  }`;

  let clauseNo = 0;
  const next = () => `${++clauseNo}.`;

  return (
    <div>
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .contract-print-area, .contract-print-area * { visibility: visible; }
          .contract-print-area {
            position: absolute; inset: 0; width: 100%;
            padding: 0; border: none; box-shadow: none; background: white;
          }
          .contract-no-print { display: none !important; }
        }
      `}</style>

      <div className="contract-no-print mb-3 flex justify-end">
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          <Printer className="mr-1.5 h-4 w-4" /> Print contract
        </Button>
      </div>

      <div className="contract-print-area rounded-xl border border-stone-200 bg-white p-8 text-stone-900 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-100">
        {/* ── Letterhead ── */}
        <div className="border-b-2 border-amber-700 pb-4">
          <p className="text-lg font-bold tracking-tight">
            {company?.branding?.logoText && (
              <span className="mr-2 text-amber-700">{company.branding.logoText}</span>
            )}
            {companyName}
            <span className="ml-1 text-sm font-normal text-stone-500">{companyReg}</span>
          </p>
          <p className="mt-1 text-xs text-stone-500">Ref: {ref} · Version {c.version}</p>
        </div>

        <h2 className="mt-6 text-center text-base font-bold uppercase tracking-wide underline underline-offset-4">
          {CONTRACT_KIND_LABELS[c.kind]}
        </h2>

        {/* ── Parties ── */}
        <p className="mt-6 text-sm leading-relaxed">
          This {CONTRACT_KIND_LABELS[c.kind]} (&ldquo;this Agreement&rdquo;) is made between{' '}
          <strong>
            {companyName}
            {companyReg}
          </strong>{' '}
          (&ldquo;the Company&rdquo;) and <strong>{counterparty}</strong>
          {counterpartyIc ? ` (NRIC / Reg. No. ${counterpartyIc})` : ''} (
          {isOfService ? '“the Employee”' : '“the Contractor”'}), collectively &ldquo;the
          Parties&rdquo;.
        </p>

        <ol className="mt-4 list-none space-y-4 text-sm leading-relaxed">
          {/* ── Appointment ── */}
          <li>
            <p className="font-semibold">{next()} Appointment and Term</p>
            <p className="mt-1">
              The Company engages {isOfService ? 'the Employee' : 'the Contractor'} as{' '}
              <strong>{c.title}</strong> commencing <strong>{fmtDate(c.startDate)}</strong>{' '}
              {c.endDate ? (
                <>
                  and continuing for a fixed term until <strong>{fmtDate(c.endDate)}</strong>,
                  unless terminated earlier in accordance with this Agreement
                </>
              ) : (
                <>on an indefinite basis, unless terminated in accordance with this Agreement</>
              )}
              .
              {isOfService && c.terms.probationMonths
                ? ` The Employee shall serve a probationary period of ${c.terms.probationMonths} month${
                    c.terms.probationMonths === 1 ? '' : 's'
                  }.`
                : ''}
            </p>
          </li>

          {/* ── Remuneration ── */}
          <li>
            <p className="font-semibold">{next()} Remuneration</p>
            <p className="mt-1">
              {isOfService ? (
                <>
                  The Company shall pay the Employee a remuneration of{' '}
                  <strong>{remunerationLine}</strong> (
                  {REMUNERATION_MODE_LABELS[c.remuneration.mode]}), payable in arrears through the
                  Company payroll.
                </>
              ) : (
                <>
                  The Company shall pay the Contractor a fee of{' '}
                  <strong>{remunerationLine}</strong> (
                  {REMUNERATION_MODE_LABELS[c.remuneration.mode]}), payable against the
                  Contractor&rsquo;s invoices upon delivery and acceptance of the agreed services.
                  Fees are paid <strong>gross</strong> — no EPF, SOCSO, EIS or monthly tax
                  deduction (MTD/PCB) shall be withheld save as required by law.
                </>
              )}
            </p>
          </li>

          {/* ── Kind-specific statutory clause ── */}
          {isOfService ? (
            <>
              <li>
                <p className="font-semibold">{next()} Hours of Work and Statutory Benefits</p>
                <p className="mt-1">
                  The Employee&rsquo;s working hours shall be{' '}
                  {c.terms.workingHours ?? 'as notified by the Company'}, and the Employee shall be
                  entitled to rest days, public holidays, annual leave, sick leave and other
                  benefits in accordance with the Employment Act 1955 (Act 265) and the
                  Company&rsquo;s policies.
                </p>
              </li>
              <li>
                <p className="font-semibold">{next()} Statutory Contributions</p>
                <p className="mt-1">
                  The Company shall make contributions to the Employees Provident Fund (EPF/KWSP),
                  the Social Security Organisation (SOCSO/PERKESO) and the Employment Insurance
                  System (EIS) at the rates prescribed by law, and shall deduct monthly tax
                  (PCB/MTD) from the Employee&rsquo;s remuneration in accordance with the Income Tax
                  Act 1967.
                </p>
              </li>
            </>
          ) : (
            <li>
              <p className="font-semibold">{next()} Independent Contractor Status</p>
              <p className="mt-1">
                The Contractor is engaged as an <strong>independent contractor</strong>. Nothing in
                this Agreement creates an employer–employee relationship, partnership, agency or
                joint venture between the Parties. The Contractor is not covered by the Employment
                Act 1955 and is not entitled to EPF, SOCSO or EIS contributions, paid leave, notice
                benefits or any other employment benefit. The Contractor is solely responsible for
                the Contractor&rsquo;s own income tax affairs, including any instalments under the
                CP500 scheme, and any withholding applicable to the Contractor&rsquo;s fees under
                the Income Tax Act 1967.
              </p>
            </li>
          )}

          {/* ── IP ── */}
          {c.terms.ipClause && (
            <li>
              <p className="font-semibold">{next()} Intellectual Property</p>
              <p className="mt-1">
                All intellectual property created by {isOfService ? 'the Employee' : 'the Contractor'}{' '}
                in the course of this engagement shall vest in and belong to the Company, save as
                otherwise agreed in writing.
              </p>
            </li>
          )}

          {/* ── Confidentiality ── */}
          {c.terms.confidentiality && (
            <li>
              <p className="font-semibold">{next()} Confidentiality</p>
              <p className="mt-1">
                {isOfService ? 'The Employee' : 'The Contractor'} shall keep confidential all
                information relating to the business, affairs and clients of the Company, both
                during and after the term of this Agreement, and shall not disclose or use such
                information except as required for the performance of this Agreement.
              </p>
            </li>
          )}

          {/* ── Non-compete ── */}
          {c.terms.nonCompete && (
            <li>
              <p className="font-semibold">{next()} Restraint</p>
              <p className="mt-1">
                During the term of this Agreement, {isOfService ? 'the Employee' : 'the Contractor'}{' '}
                shall not engage in any business or activity that directly competes with the
                business of the Company without the Company&rsquo;s prior written consent.
              </p>
            </li>
          )}

          {/* ── Termination ── */}
          <li>
            <p className="font-semibold">{next()} Termination</p>
            <p className="mt-1">
              Either Party may terminate this Agreement by giving{' '}
              <strong>
                {c.terms.noticeWeeks ?? 4} week{(c.terms.noticeWeeks ?? 4) === 1 ? '' : 's'}
              </strong>
              &rsquo; written notice to the other
              {isOfService
                ? ', or payment in lieu of notice, in accordance with the Employment Act 1955'
                : ''}
              .{c.endDate ? ' This Agreement otherwise lapses automatically on its end date.' : ''}
            </p>
          </li>

          {/* ── Governing law ── */}
          <li>
            <p className="font-semibold">{next()} Governing Law</p>
            <p className="mt-1">
              This Agreement is governed by and construed in accordance with the laws of Malaysia,
              and the Parties submit to the exclusive jurisdiction of the courts of Malaysia.
            </p>
          </li>
        </ol>

        {/* ── Signature block ── */}
        <div className="mt-10 grid grid-cols-2 gap-8 text-sm">
          <div>
            <p className="font-semibold">For and on behalf of the Company</p>
            <div className="mt-10 border-t border-stone-400 pt-1">
              <p>{c.party.companySigner}</p>
              <p className="text-xs text-stone-500">Authorised signatory · Date</p>
            </div>
          </div>
          <div>
            <p className="font-semibold">{isOfService ? 'The Employee' : 'The Contractor'}</p>
            <div className="mt-10 border-t border-stone-400 pt-1">
              <p>{c.signedBy ?? counterparty}</p>
              <p className="text-xs text-stone-500">
                Signature{c.signedAt ? ` · Signed ${fmtDate(c.signedAt)}` : ' · Date'}
              </p>
            </div>
          </div>
        </div>

        <p className="mt-6 text-center text-[10px] text-stone-400">
          Generated by the HRMS contracts register · {ref} v{c.version} · This document is a
          template generated from recorded contract data and does not constitute legal advice.
        </p>
      </div>
    </div>
  );
}
