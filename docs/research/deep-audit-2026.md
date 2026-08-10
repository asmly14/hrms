# HRMS Deep Audit 2026 — Synthesis & Prioritized Roadmap

Synthesis of 6 specialist audits (all evidence with file:line in the individual reports):

| # | Report | Headline finding |
|---|---|---|
| 1 | [audit-business-value.md](audit-business-value.md) | Statutory depth beats every competitor; trust-killing dead ends (fake notification bell, dead search, no ESS payslip path) |
| 2 | [audit-code-efficiency.md](audit-code-efficiency.md) | 59,934 LOC; ~12.7–15.1% reducible; single 2,653 kB chunk; 27 unused shadcn files (3,803 LOC) |
| 3 | [audit-ux.md](audit-ux.md) | sonner never mounted (silent mutations); mobile bottom-nav dead-end (8+ routes unreachable); 65 unassociated labels |
| 4 | [audit-database.md](audit-database.md) | 14 bypass collections dropped by export/migrator; 100-emp tenant breaches localStorage in year 1; 5-doc onboarding = 4.67 MB |
| 5 | [audit-multitenant.md](audit-multitenant.md) | Isolation sound except ONE leak (attendance rotations global key); no tenant deletion; suspend toothless; payslipPrefix dead |
| 6 | [audit-sdlc.md](audit-sdlc.md) | 274 tests green but 0 UI tests; lint fails (45 errors); zero CI/CD; 2 critical fast-jwt vulns; plaintext passwords |

## P0 — Trust & safety (do first, ~1 week)

1. **Fix the dead ends**: wire notification bell to live pending counts; make global search work or remove it; enable "Import data" or hide it; remove fake unread dot. (Audit 1 §dead-ends, Audit 3)
2. **Mount sonner Toaster + toast on every mutation** (approve, finalize, clock, save). (Audit 3 P0)
3. **Mobile nav fix**: hamburger menu or full nav sheet on small screens. (Audit 3 P0)
4. **ESS payslips path**: "My payslips" entry visible to Employee role. (Audit 1)
5. **Tenant isolation leak**: namespace `myhrms:attendance:rotations` per tenant. (Audit 5)
6. **Security stopgaps**: bump fast-jwt + react-router + lodash (npm audit fix); hash demo passwords at rest (SHA-256 + salt, still client-side); gitignore .env everywhere; remove `smithang/123123` from repo → seed-time env/demo flag. (Audit 6)
7. **CI baseline**: GitHub Actions from audit-sdlc.md YAML (test+lint+build on push; deploy to Pages on main). (Audit 6)

## P1 — Data durability & code health (~2–4 weeks)

8. **Unified collection registry**: fold the 14 typed-cast collections into db.ts COLLECTIONS so export/migrator/backups stop dropping them; fix JSON export coverage; seed-race fix (await dynamic imports). (Audit 4 Phase 0)
9. **Document-bytes store**: split base64 files into a separate per-tenant store w/ quota guards + compression; cap total per employee. (Audit 4)
10. **Cascade integrity**: extend deleteEmployeeCascade to contracts/records/onboardingExtras/lifecycle/objectives/checkins/pips; unbounded-audit rotation. (Audit 4)
11. **Code-splitting**: React.lazy per route + manualChunks (vendor/recharts/orgchart) — 660→~300 kB gzip initial. (Audit 2)
12. **Consolidation**: delete 27 unused ui files + empty dirs; single `lib/useAuthSafe.ts`; merge CSV builders; FormDialog/FormField/DataTable/StatCard primitives (≈2,800 LOC). Fix appSettings static+dynamic import mix. (Audit 2)
13. **Config teeth**: payslipPrefix applied to payslip refs; workingWeek/payrollCutoffDay consumed or removed; leaveTopUps single read path; suspend blocks login (web + server). (Audit 5)

## P2 — Product moats (~1–3 months)

14. **Unified approvals inbox** (leave+claims+OT in one screen — composition of existing components) + real notification center. (Audit 1)
15. **GL/accounting export** (Xero/QBO journal CSV) — the deal-winner gap vs PayrollPanda/Talenox. (Audit 1)
16. **Year-end pack**: Form E + CP8D + CP21 (EA-form pattern already proven). (Audit 1)
17. **Batch payslip PDF + distribution flag**; dept/cost-centre payroll rollup. (Audit 1)
18. **Tenant lifecycle**: tenant deletion w/ PDPA erasure cascade; trial expiry enforcement; impersonation audit trail. (Audit 5)
19. **UI test layer** (jsdom + Testing Library on critical flows), lint zero-tolerance in CI. (Audit 6)
20. **Mobile ESS parity**: real auth + shared data (needs backend cutover). (Audit 1/4)

## Strategic (backend cutover)

Phased DB plan (Audit 4): Phase 0 localStorage hardening → Phase 1 schema parity (add 8 missing collections to server) + cascade endpoint → Phase 2 API pilot + RLS + pagination → Phase 3 cutover. Est. 6–10 weeks total. Backend adds: RLS, FK constraints, files strategy (object storage, not base64), server tests.
