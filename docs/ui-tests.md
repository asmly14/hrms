# UI test layer (jsdom + Testing Library)

Closes the SDLC audit gap (`docs/research/audit-sdlc.md` §"UI/component tests —
Absent"): the React layer now has component/flow tests alongside the pure-TS
lib suite.

## Layout

| Path | Purpose |
| --- | --- |
| `vitest.config.ts` | Two Vitest **projects**, one `npm test` run: `node` (existing pure-TS tests: `src/lib/**`, `src/pages/**/__tests__`) and `ui` (jsdom, `src/__tests__/**/*.test.tsx`). |
| `src/test/setup.ts` | ui-project setup: `@testing-library/jest-dom` matchers, `matchMedia` / `ResizeObserver` / `IntersectionObserver` / `scrollIntoView` polyfills, `navigator.geolocation` stub, and a **recharts `ResponsiveContainer` stub** (jsdom has no layout engine; a fixed 800×400 box mounts chart children). |
| `src/test/providers.tsx` | The provider stack mirroring `App.tsx` (`RoleProvider → TenantProvider → AuthProvider`). Component-only module (react-refresh lint). |
| `src/test/helpers.ts` | `freshDemoTenant()` (memory-storage stub from `src/lib/__tests__/storageStub` + `seedTenantIfEmpty('co-asm', force)` + `seedUsers()`), `loginAs()`, `renderWithProviders()`, payroll fixtures (`makeRun` / `makePayslip` / `seedPayroll`). |
| `src/__tests__/*.test.tsx` | The flow tests below. |

## Flow coverage (21 tests)

| File | Flow | Tests |
| --- | --- | --- |
| `login.test.tsx` | (a) LoginPage render, invalid-credential inline error, empty-submit error, demo-chip quick-fill, successful login writes `hrms.session` + navigates | 5 |
| `app-shell.test.tsx` | (b) Admin shell smoke: sidebar nav + dashboard stat cards after login; unauthenticated → `/login` redirect | 2 |
| `apply-leave.test.tsx` | (c) ApplyLeaveForm: renders, empty dates → inline error + disabled submit, end-before-start → error, valid → request added + `toast.success` spy fired (sonner mocked per-file) | 4 |
| `my-payslips.test.tsx` | (d) Ownership: employee sees ONLY own finalized-run payslips — no colleague rows, no draft-run rows; empty state; unlinked account notice | 3 |
| `role-gate.test.tsx` | (e) Employee → `/settings` and `/employees` redirect to dashboard; Admin reaches `/settings` | 3 |
| `bulk-bar.test.tsx` | (f) EmployeesPage (real page, mounts fine under jsdom): no bar pre-selection, select → "N selected" bar appears, clear → bar dismisses, select-all selects all 30 seeded employees | 4 |

## Mock strategy

- **recharts**: global `vi.mock` in `src/test/setup.ts` — everything passes
  through except `ResponsiveContainer` (fixed-size div).
- **sonner**: per-file `vi.mock` in `apply-leave.test.tsx`; the assertion is
  the `toast.success` call (spy), not rendered pixels.
- **localStorage**: the lib tests' `MemoryStorage` stub is reinstalled per
  test via `freshDemoTenant()` — jsdom's own localStorage persists within a
  file and would leak state between tests.
- **geolocation**: `Object.defineProperty(navigator, 'geolocation', …)` stub
  (attendance clock panel reads it).

## Query notes

- Role/text queries throughout — no `data-testid` was added to any shared
  file.
- Pages render BOTH their desktop table and mobile cards in jsdom (no CSS
  media queries apply), so duplicate text/checkbox matches are handled with
  `findAllByText` / `getAllByRole`.
- `EmployeesPage` row icon-buttons and the bulk bar share the accessible
  name "Separation actions"; bulk-bar assertions key on the bar-only
  "N selected" count and "Clear selection" button instead.

## Gates

- `npm test` — both projects in one run: 350 node tests + 21 ui tests green.
- `npx tsc -b` — clean for all files above.
- `npm run lint` — 0 errors for all files above.

## Writing more UI tests

Add `*.test.tsx` under `src/__tests__/` (jsdom project picks it up
automatically). Start each test with `await freshDemoTenant()` and use
`loginAs(user, pass)` + `renderWithProviders(<Page />)` from
`src/test/helpers`. Keep queries role/text-first.
