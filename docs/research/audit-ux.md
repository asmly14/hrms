# UX Audit — MY HRMS (hrms-web + hrms-mobile)

**Auditor:** AUD_UX · **Date:** 2026-08-10 · **Scope:** `hrms-web/` (React 19 + TS + Tailwind + shadcn, localStorage demo backend), with notes on `hrms-mobile/`. Read-only audit; all findings traced through source with file:line references.

---

## 1. Executive summary

The app is **structurally strong**: warm, consistent design language; genuine table→card mobile patterns on the money pages; good empty states and skeletons on most list pages; careful inline validation on forms (leave, claims, wizards). The core payroll engine UX (wizard → draft → review → finalize → statutory outputs) is thoughtfully staged.

The **biggest cross-cutting defect is feedback**: the `sonner` Toaster component exists (`src/components/ui/sonner.tsx:11,38`) but is **never mounted and `toast()` is never called anywhere in `src/`** — zero matches. Every workflow mutation (payroll finalize, leave/claim approvals, clock-in, claim submit, company create) either closes a dialog silently or relies on a one-off inline alert. Second is **mobile navigation**: the bottom nav hardcodes 5 paths (`AppLayout.tsx:70`), leaving 12+ routes unreachable on a phone with no hamburger fallback. Third is the **2.53 MB single-bundle** initial load with no route-level code-splitting.

Top P0s: mount sonner + toast all mutations; fix mobile nav dead-end; route-based code-splitting; add "My leave requests" + employee payslip access in the web app; add overflow protection to the statutory-output tables.

---

## 2. Journey maps with friction tables

### J1 — Owner/Admin runs payroll end-to-end

**Path traced:** `/login` → Dashboard → `/payroll` (PayrollHome) → "Run payroll" → RunPayrollWizard (month/employees → pre-flight → summary) → `/payroll/runs/:id` (RunDetail, draft) → Adjust per employee → "Finalize run" → Statutory outputs tab → CSV / bank giro download.

**Steps:** ~10–12 clicks for a clean run; more with adjustments. Overall the best-designed journey in the app.

| # | Friction | Evidence |
|---|----------|----------|
| J1.1 | **No success feedback on Finalize/Undo** — dialog closes, badge flips silently; easy to miss that anything happened (no toast system exists at all) | `RunDetail.tsx:115-125`; `main.tsx` (no `<Toaster>`) |
| J1.2 | `runPayroll()` executes **synchronously** on the main thread inside the wizard — no progress state; will freeze on large headcounts | `RunPayrollWizard.tsx:140-148` |
| J1.3 | Wizard step indicator is display-only; from step 2 you can go Back, but on step 3 there is no way back except closing the dialog (loses nothing, but feels terminal) | `RunPayrollWizard.tsx:180-198, 373-403` |
| J1.4 | **Statutory outputs = 7 raw tables with no `overflow-x` wrapper and no card variant** — the filing step (EPF Form A, Borang 8A, CP39, giro) breaks layout on mobile | `StatutoryOutputs.tsx:80,145,212,274` (grep: 0 `overflow-x`, 0 `md:hidden`) |
| J1.5 | Desktop run-history row actions are icon-only ghost buttons with `title` tooltips — invisible affordance on touch, no aria-label | `PayrollHome.tsx:196-213` |
| J1.6 | **No payslip distribution step**: per-payslip `window.print()` exists, but no bulk print, no email stub, and employees cannot reach their own payslip in the web app (see J3.4) | `PayslipPage.tsx:117`; `AppLayout.tsx:46-59` |
| J1.7 | Notification bell shows a static "Payroll reminder" that never changes and doesn't deep-link — a real due-date affordance is faked | `AppLayout.tsx:194-205` |

Good: re-run/undo/finalize all use proper `AlertDialog` with consequence copy (`PayrollHome.tsx:276-346`, `RunDetail.tsx:438-495`); draft-run gating of statutory exports has a clear locked empty state (`RunDetail.tsx:400-413`); footer totals follow the active filter (`RunDetail.tsx:74-93`); skeleton + grace-window + two distinct empty states on run history (`PayrollHome.tsx:59-152`).

### J2 — New-hire onboarding via invite link

**Path traced:** HR: `/onboarding` → "Invite links" tab → Generate link (label + optional position/dept + expiry) → copy / WhatsApp / email share → applicant opens `/onboard/:token` (6-step wizard: personal → contact/bank → emergency → academics → documents → PDPA declaration) → submit → HR reviews in InviteLinksPanel → SubmissionReviewDialog → Approve → employee record created.

| # | Friction | Evidence |
|---|----------|----------|
| J2.1 | **No draft persistence** — 6 steps of applicant data live in `useState` only; an accidental refresh/close loses everything (documents must be re-uploaded even on *sanctioned* resubmission) | `OnboardFormPage.tsx:94-97, 257` |
| J2.2 | English-only form for a Malay-first applicant pool; PDPA declaration EN-only | whole `steps/` tree; `index.html:2 lang="en"` |
| J2.3 | `submitting` state is set true→false around a **synchronous** localStorage write — the "Submitting…" label never renders; no async affordance | `OnboardFormPage.tsx:233-235` |
| J2.4 | Success screen gives a reference ID but no "what happens next" timeline or contact route | `OnboardFormPage.tsx:183-205` |
| J2.5 | "Welcome packet" card is a static placeholder ("Coming in Wave 2") occupying prime page space | `OnboardingPage.tsx:242-261` |

Good: token problem states are friendly and specific (invalid/revoked/expired/submitted/approved — `OnboardFormPage.tsx:125-177`); share actions include WhatsApp deep link (`GenerateLinkDialog.tsx:170-197`); resubmission flow prefills data and surfaces HR's note (`OnboardFormPage.tsx:249-260`); documents stored as base64 dataURLs with ~700 KB cap and image preview (`steps/DocumentsStep.tsx:4,46-84`); expired-date display and per-step validation with jump-to-first-error on submit (`OnboardFormPage.tsx:225-232`).

### J3 — Employee: clock in + apply leave + submit claim

**Path traced:** Dashboard → `/attendance` (Clock tab is default) → Clock In → `/leave` → Apply tab → submit → `/claims` → New claim dialog → submit → track in "My claims".

| # | Friction | Evidence |
|---|----------|----------|
| J3.1 | **No "My requests" view for leave** — after applying, the inline success alert is the only confirmation; the employee cannot see their own pending/approved/rejected requests anywhere (Balances shows a pending *count*; Team calendar shows approved only). Approvals tab is **disabled** for Employees yet its empty-state text says "Your own requests appear here once submitted" — unreachable, contradictory copy | `LeavePage.tsx:56-75` (tabs: Balances/Apply/Approvals/Calendar), `LeavePage.tsx:64` (`disabled={!canApprove}`), `ApprovalsQueue.tsx:119-122` |
| J3.2 | **Claims is the gold standard** (submit → visible status list → decision remarks) — but "Save as draft" demands a *fully valid* form, so you can't park a half-filled claim | `ClaimFormDialog.tsx:122-125` |
| J3.3 | Receipt upload is a **placeholder** — only the filename is stored, file bytes discarded; label admits it, but users will believe they attached proof. Approvers see a paperclip with a name, not the receipt | `ClaimFormDialog.tsx:284-309`, `ApproverInbox.tsx:271-275` |
| J3.4 | **Employee payslip access absent in hrms-web**: `/payroll` is Admin/HR-only in nav and route roles; `/payroll/payslip/:id` has an ownership guard but no navigation path leads an employee to it. Payslips only exist in the separate `hrms-mobile` app | `App.tsx:84-86`, `AppLayout.tsx:46-59`, `PayslipPage.tsx:63-69` |
| J3.5 | Clock-in requires a browser geolocation prompt with an 8 s wait on failure before the record is created (flagged) — acceptable, but the only feedback is a muted inline sentence; no toast | `ClockPanel.tsx:106-122, 191-199` |
| J3.6 | Dashboard QuickActions for employees link Attendance + Claims but **not Leave** or Clock — the two most frequent self-service tasks | `dashboard/components/quick-actions.tsx:24-37` |

Good: clock buttons are excellent touch targets (`h-16`, `ClockPanel.tsx:295-313`); late/geofence/protected-status messaging is specific; leave form has live validation, balance summary, PH/rest-day exclusion explainers, unpaid-leave payroll-impact estimate (`ApplyLeaveForm.tsx:82-114, 257-269`); claims policy warnings are soft and informative (`ClaimFormDialog.tsx:311-326`).

### J4 — Manager approves (leave / claims / OT)

**Path traced:** `/leave` → Approvals tab (badge count) → Approve/Reject dialog + remarks → confirm. `/claims` → Approvals tab → row or bulk approve → dialog → confirm. `/attendance` → Overtime tab → decide.

| # | Friction | Evidence |
|---|----------|----------|
| J4.1 | **Three disconnected approval queues** (leave, claims, OT) with no unified inbox or cross-links; a manager must visit 3 pages to clear their morning queue | `LeavePage.tsx:64`, `ClaimsPage.tsx:257-263`, `AttendancePage.tsx:49` |
| J4.2 | No post-decision feedback beyond the row moving lists (no toast) | `ApprovalsQueue.tsx:130-173` |
| J4.3 | Bulk approve exists for **claims only**; leave and OT are one-at-a-time | `ApproverInbox.tsx:297-309` vs none in `ApprovalsQueue.tsx` |
| J4.4 | Decision dialogs are plain `Dialog`, not `AlertDialog` — inconsistent with payroll's destructive confirmations (see §6.3) | `ApprovalsQueue.tsx:326,377` vs `PayrollHome.tsx:276` |
| J4.5 | Notification bell's "3 leave requests pending" is static and doesn't link to the queue | `AppLayout.tsx:198-201` |

Good: self-approval is blocked everywhere with explanatory copy (`ApprovalsQueue.tsx:239-242`, `ApproverInbox.tsx:221-226`); live balance re-check blocks over-approvals (`ApprovalsQueue.tsx:94-106, 341-349`); claims queue has category totals and a sticky bulk bar; department scoping is explicit in the UI.

### J5 — HR sets up a new company (Company Setup)

**Path traced:** (system view → company picker) → `/company` → tabs: Profile / Branding / Modules / Work & Payroll Policy / Custom Fields → edit → Save changes per section.

| # | Friction | Evidence |
|---|----------|----------|
| J5.1 | Topbar company dropdown **looks like a tenant switcher but is display-only** (two info items, no actions) — multi-company HR must go through the SuperAdmin banner or Company Setup to switch | `AppLayout.tsx:153-171` |
| J5.2 | Policy sections' tables have **zero empty states** — render bare headers when unconfigured | `PolicySection.tsx`, `settings/sections/LeavePolicySection.tsx` (grep: 0 empty guards) |
| J5.3 | Module toggles apply instantly with no undo/confirm; disabling the module you're standing in ejects you to a "disabled" card with no warning | `ModulesSection.tsx:81-83`, `App.tsx:162-169` |

Good: per-section SaveButton with 2.2 s "Saved" state (`settings/shared.tsx:53-70`); unsaved-changes guard (`ProfileSection.tsx:43`); deep-linkable tabs via `?tab=` (`CompanyPage.tsx:53-55`); system-view picker with brand dots (`CompanyPage.tsx:57-95`); branding applies live app-wide.

### J6 — SuperAdmin provisions a tenant

**Path traced:** `/superadmin` → Companies → "New company" → 4-step wizard (Basics → Configuration → Admin account → Review) → success screen with credentials → "Enter company".

| # | Friction | Evidence |
|---|----------|----------|
| J6.1 | Generated admin password shown once in a mono block with **no copy button** — hand-transcription error risk | `CreateCompanyWizard.tsx:284-293` |
| J6.2 | New tenant starts EMPTY by design, but the wizard never offers to seed demo data or link the admin to first-run setup guidance; first login lands on an empty dashboard | `CreateCompanyWizard.tsx:9-13, 271-276` |
| J6.3 | Suspend/reactivate flows in the directory use inline confirms? — directory actions exist (Enter/Edit/Suspend) but suspension consequences aren't previewed | `CompaniesSection.tsx` |

Good: per-step validation with specific messages; auto-derived employee/payslip prefixes that stay in sync until overridden (`CreateCompanyWizard.tsx:106-120`); weekend default follows HQ state; clear trial-status framing; duplicate code/username checks; restricted-access notice for non-SuperAdmin (`SuperAdminPage.tsx:26-49`).

---

## 3. Mobile responsiveness issues

**Method:** checked every page for table→card handling, nav coverage, touch targets, and the org chart.

| # | Issue | Severity | Evidence |
|---|-------|----------|----------|
| M1 | **Bottom nav covers only `/`, `/attendance`, `/leave`, `/claims`, `/kpi`** — hardcoded `MOBILE_PATHS`, sliced to 5. On a phone, Admin/HR cannot reach Employees, Payroll, Org, Org Chart, Holidays, Contracts, Onboarding, Offboarding, Reports, Salary Insights, Company Setup, Settings, Super Admin. No hamburger/drawer exists; only Dashboard QuickActions (Employees + Payroll cards) partially backfill | **Critical** | `AppLayout.tsx:70, 287-313` |
| M2 | Statutory outputs tables (7 tables) — no overflow wrapper, no cards | High | `StatutoryOutputs.tsx:80-274` |
| M3 | OrgPage structure tables (2) — no overflow wrapper, no cards | High | `OrgPage.tsx:294,391` |
| M4 | Policy tables (Company PolicySection, Settings LeavePolicySection) — no overflow/cards + no empty states | Medium | `PolicySection.tsx`, `LeavePolicySection.tsx` |
| M5 | Tables with **proper** fallbacks (verified good): PayrollHome, RunDetail, EmployeesPage, MyClaimsList, ApproverInbox, BalancesPanel use `hidden md:block` + `md:hidden` cards; ContractsPage, IncrementSimulator, CompaniesSection, ActivitySection, SystemSection use `overflow-x-auto`; InviteLinksPanel hides columns progressively (`hidden md:table-cell`) | — | e.g. `PayrollHome.tsx:156/223`, `MyClaimsList.tsx:287/333` |
| M6 | Org chart on small screens: toolbar (7 controls) wraps into 3+ rows; MiniMap overlays ~⅓ of a 375 px canvas; node text ~11 px. ReactFlow touch-pan works, but position editing is drag-only (no keyboard/touch alternative) | Medium | `OrgChartPage.tsx:529-628` |
| M7 | Wizard dialogs use `max-h-[90vh] overflow-y-auto` with non-sticky footers — primary action scrolls below the fold on short viewports | Low | `RunPayrollWizard.tsx:171`, `CreateCompanyWizard.tsx:263` |
| M8 | Touch targets: bottom-nav items ~48 px ✓; clock buttons `h-16` ✓; icon-only `h-8` ghost buttons are desktop-table-only ✓ (acceptable) | — | `AppLayout.tsx:294-311`, `ClockPanel.tsx:295` |
| M9 | `hrms-mobile/` is a separate app with an exemplary shell (60 px tabs, safe-area inset, active pill, aria-labels) — but it duplicates rather than resolves hrms-web's mobile gaps, and shares no session/identity with the web app | Info | `hrms-mobile/src/components/PhoneShell.tsx:46-76` |

---

## 4. Accessibility quick scan

| # | Issue | Severity | Evidence |
|---|-------|----------|----------|
| A1 | **65 of 226 `<Label>` usages have no `htmlFor`** — most pair with shadcn `Select` triggers (which need `aria-labelledby`, not `htmlFor`), so labels are visual-only; clicking the label does nothing | Medium | e.g. `ClockPanel.tsx:239,261`, `EmployeeFormFields.tsx:97-241`, `OTManager.tsx:280,323`, `TimesheetView.tsx:132` |
| A2 | **Light-theme contrast failures**: computed WCAG ratios — primary button text 4.18:1 and primary-colored text/links 4.08:1 vs the 4.5 AA threshold (both pass for large text only). Dark theme passes (8.11 / 6.85) | Medium | tokens `index.css:16,49`; ratios computed from HSL tokens (`--primary: 32 85% 38%` light) |
| A3 | Icon-only buttons rely on `title` (hover tooltip) without `aria-label` — title does supply an accessible name, but nothing is exposed to touch users | Low | `PayrollHome.tsx:196,204`, `RunDetail.tsx:297` |
| A4 | Dialogs/AlertDialogs/Sheets are Radix-based — focus trap, Esc, and focus return all work; no custom modals found. **No keyboard traps detected** | Pass | `components/ui/dialog.tsx`, `alert-dialog.tsx` |
| A5 | `role="alert"` on login and onboard-form errors ✓; `aria-busy` on leave skeleton ✓; aria-labels on password toggle, bell, dark-mode ✓ | Pass | `LoginPage.tsx:143,183`, `LeavePage.tsx:32`, `AppLayout.tsx:186,209` |
| A6 | No skip-to-content link; charts (recharts) have no text alternatives (stat cards partially compensate); org-chart canvas not keyboard-operable | Low | `AppLayout.tsx:356-377`, `dashboard/components/charts.tsx`, `OrgChartPage.tsx:585` |

---

## 5. Performance UX

| # | Issue | Severity | Evidence |
|---|-------|----------|----------|
| P1 | **Initial JS = one 2,653 KB chunk (≈655 KB gzip)**; every page component is eagerly imported in `App.tsx` (only NotFound is lazy); `vite.config.ts` has no `manualChunks`. First visit downloads superadmin, org chart (ReactFlow), insights (recharts), EA-form generator, etc. CSS adds 131 KB (21 KB gzip) | **Critical** | `dist/assets/index-*.js` (measured), `App.tsx:14-42`, `vite.config.ts` |
| P2 | Loading patterns are inconsistent by design: grace windows of 600 ms (Claims, Onboarding) vs 1500 ms (Payroll) vs none (Leave shows skeletons whenever employees is empty) — usually fine, but a genuinely empty company sees 1.5 s of skeletons before the empty state | Low | `PayrollHome.tsx:59-65`, `ClaimsPage.tsx:65-70`, `LeavePage.tsx:30-44` |
| P3 | All mutations are synchronous localStorage writes → effectively "optimistic" everywhere with zero pending states; the inverse problem: heavy ops (`runPayroll`, PNG export, reseed) show **no progress indicator** and block the UI | Medium | `RunPayrollWizard.tsx:140`, `OrgChartPage.tsx:555`, `SystemSection.tsx` |
| P4 | Skeleton usage is good where present (Payroll, Claims, Onboarding, Employees, Leave) but absent on KPI, Insights, Org, Reports (content pops in after seed) | Low | grep: no `Skeleton` import in those pages |

---

## 6. Consistency

### 6.1 Currency & date formatting (`fmtRM` / `fmtDate`)

Adoption is strong (~450 references; `utils.ts:9-22`). Violations:

| Location | Violation |
|----------|-----------|
| `lib/payrollEngine.ts:340,562,628,655,716` | Activity-feed amounts via bare `.toFixed(2)` — no `RM` prefix, no thousands separators; `:340` writes "RM1700" (no space) |
| `lib/employeeRecords.ts:513,527` | `RM ${salary.toFixed(2)}` — no thousands separators |
| `pages/employees/helpers.ts:277`, `pages/employees/separations.ts:237` | Hand-rolled `RM ${n.toLocaleString('en-MY')}` (no sen decimals) |
| `pages/insights/StateCompareTool.tsx:27`, `pages/insights/SalaryRangeChart.tsx:19` | Local `shortRM` duplicates (0-decimal) — deliberate axis formatting, but bypasses the single formatter rule |
| `pages/superadmin/OverviewSection.tsx:149` | `RM${PLAN_RATES.pro}` — no space, no formatting |
| Locale mixing | `fmtDate` uses `en-GB` ("5 Mar 2026") but `HolidaysPage.tsx:289` and `TeamCalendar.tsx:110` use `en-MY`; `dashboard/lib.ts:33,39` rolls its own en-GB variants |

### 6.2 Terminology

- **Claims module is triple-named**: nav "Claims" (`AppLayout.tsx:58`) → H1 "e-Claims" (`ClaimsPage.tsx:194`) → copy "Submit expenses" / "Expense date" (`ClaimsPage.tsx:197`, `ClaimFormDialog.tsx:202`, `MyClaimsList.tsx:272`). Module description says "Expense claims" (`company/modules.ts:45`).
- **Leave is consistent** — no "Time Off" anywhere ✓.
- "KPI" (nav) vs "KPI & Performance" (route title); "NRIC" (EmployeesPage) vs "IC" (`RunPayrollWizard.tsx:151`, search placeholders).
- Statutory naming (EPF/SOCSO/EIS/PCB/Borang 8A/CP39/EA form) is consistently and correctly Malaysian ✓.

### 6.3 Confirm-dialog inconsistency

- **14 files** use `AlertDialog` (payroll rerun/undo/finalize, claim delete, employee deletion…).
- **~20 files** use plain `Dialog` for decision/confirm flows: leave approve/reject/cancel (`ApprovalsQueue.tsx:326,377`), claims approve/reject (`ApproverInbox.tsx`), shift deletes (`ShiftsPage.tsx`), all records-tab deletes (`employees/records/*`).
- **Zero `window.confirm`** in app flows ✓ (`ProbationStrip.tsx:95` is a local handler, not the native dialog).

### 6.4 Approval-gating inconsistency

Leave hides its Approvals tab via `disabled` (greyed but visible, `LeavePage.tsx:64`); Claims conditionally removes the tab entirely (`ClaimsPage.tsx:257`); OT's queue is always visible. Pick one pattern.

### 6.5 Empty-state coverage per page

Good coverage (dedicated `Empty` component): Employees, Payroll home, Run detail, My claims, Approver inbox, Leave approvals, Onboarding, Companies, Activity, Reports, KPI suite, Holidays, Org chart, Today board, Timesheet, OT queue, Anomaly list, Contracts.
**Gaps:** `company/sections/PolicySection.tsx` and `settings/sections/LeavePolicySection.tsx` (tables, zero guards); `OnboardFormPage` document list is fine; static "Coming in Wave 2" welcome packet and disabled "Scan receipt" are placeholder-UI masquerading as features.

### 6.6 Dead clicks & fake controls

| Control | Reality | Evidence |
|---------|---------|----------|
| Global search input | Enter always navigates to `/employees`, query ignored | `AppLayout.tsx:173-182` |
| Notification bell + amber dot | 3 hardcoded items, no links, dot always on | `AppLayout.tsx:186-207` |
| Company dropdown (topbar) | Display-only; no tenant switching | `AppLayout.tsx:153-171` |
| "Scan receipt" button | Permanently disabled with "Coming soon" tooltip | `ClaimsPage.tsx:217-227` |
| Receipt file input | Stores filename only | `ClaimFormDialog.tsx:284` |

---

## 7. Language / bilingual opportunity

- App is English-only: `index.html:2 lang="en"`, no i18n library, no BM strings anywhere in `src/`.
- For the Malaysian market this is a real gap on **employee-facing surfaces**: the public onboarding form (`/onboard/:token`), clock panel, leave application, payslip, and PDPA declaration are exactly where BM matters most (many applicants and site workers are BM-first).
- Cheap wins already in place: `fmtRM`/`fmtDate` are locale-ready (`en-MY`/`en-GB`); statutory artifacts already carry Malay names (Borang 8A, CP39, EA form, MyInvois).
- Recommendation: introduce a lightweight i18n layer (e.g. `react-i18next` or a key-based dictionary given the app's size), EN default + BM toggle, starting with the 5 surfaces above; set `lang` dynamically.

---

## 8. Prioritized fix list

### P0 — blocks or breaks core journeys

1. **Mount `<Toaster />` (sonner) in `main.tsx` and toast every workflow mutation** — payroll finalize/undo/run, leave & claim & OT decisions, clock in/out, claim submit, company create, link generate/revoke. The component and dependency exist; usage is zero. (`components/ui/sonner.tsx`, `main.tsx`)
2. **Fix mobile navigation dead-end** — add a "More" tab + drawer (or hamburger) listing all role-visible routes; 12 routes are currently unreachable on phones. (`AppLayout.tsx:70,287-313`)
3. **Route-level code-splitting** — `lazy()` every page in `App.tsx` (pattern already exists for NotFound), add `manualChunks` for react/recharts/reactflow/radix; target <400 KB initial gzip. (`App.tsx:14-42`, `vite.config.ts`)
4. **Employee self-service holes** — add "My requests" list to `/leave` (status + remarks + cancel-before-start) and give employees a `/payroll/payslip/:id` entry point (e.g. dashboard "My payslips" card). (`LeavePage.tsx`, `ApprovalsQueue.tsx:119-122`, `AppLayout.tsx:46-59`)
5. **Overflow-protect the statutory-output and Org tables** — wrap in `overflow-x-auto` or add card variants; the payroll *filing* step is currently broken on mobile. (`StatutoryOutputs.tsx`, `OrgPage.tsx:294,391`, `PolicySection.tsx`, `LeavePolicySection.tsx`)

### P1 — high-friction, high-visibility

6. Kill or implement the fake controls: global search (wire to real employee/page search or remove), notification bell (live counts + deep-links to approval queues, or remove dot), topbar company dropdown (make it a real tenant switcher). (`AppLayout.tsx:153-207`)
7. **Unified approvals inbox** (or at minimum cross-links + pending counts on the dashboard); extend bulk-approve to leave and OT. (`ApprovalsQueue.tsx`, `ApproverInbox.tsx`, `OTManager.tsx`)
8. Standardize all destructive/decision confirms on `AlertDialog`; align tab-gating pattern across leave/claims/OT. (~20 files)
9. Make receipt upload real (base64 like onboarding docs) or drop the field; hide "Scan receipt" until OCR ships. (`ClaimFormDialog.tsx:284`, `ClaimsPage.tsx:217-227`)
10. Contrast pass: darken light `--primary` (≈`32 85% 32%`) or use `amber-800`-class text so button text and primary links hit ≥4.5:1. (`index.css:16`)
11. Onboarding form: persist draft to localStorage per token (resume on refresh); add EN/BM toggle for the public form + PDPA declaration. (`OnboardFormPage.tsx:94-97`)
12. A11y sweep: associate the 65 orphan `Label`s (`htmlFor` or `aria-labelledby` on Select triggers); add `aria-label` to icon-only buttons; add skip-to-content link.

### P2 — polish

13. Formatting sweep: route the 8 hand-rolled currency/date spots through `fmtRM`/`fmtDate`; pick one display locale (`en-MY` vs `en-GB`). (§6.1 table)
14. Terminology pass: one name for the claims module (nav + H1 + copy); NRIC vs IC; KPI titles. (§6.2)
15. Async affordances: progress state for `runPayroll`, reseed, PNG export; unify seed-loading heuristics (single `useSeedReady()` hook instead of 600/1500 ms grace timers).
16. Payslip distribution: bulk print/PDF + email stub; copy button for superadmin credentials; offer optional demo seed in the create-company wizard. (`PayslipPage.tsx`, `CreateCompanyWizard.tsx:284-293`)
17. Empty states for `PolicySection` / `LeavePolicySection`; remove or park "Coming in Wave 2" cards behind a roadmap note.
18. Charts: text summaries for dashboard charts; keyboard alternative for org-chart position editing.

---

## 9. What not to touch (verified good)

- Payroll run/draft/finalize staging and its `AlertDialog` consequence copy — best-in-app.
- Claims employee loop (submit → status → remarks) and policy-warning UX.
- Clock panel touch targets and geofence messaging.
- Onboarding token error states and share actions.
- `SaveButton` inline saved feedback in settings/company sections.
- `hrms-mobile` PhoneShell (tabs, safe area, targets).
- Empty-state + skeleton coverage on the major list pages.
