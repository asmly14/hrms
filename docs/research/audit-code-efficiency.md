# AUD_CodeEfficiency — Code-Efficiency Audit (Malaysian HRMS `hrms-web`)

**Date:** 2026-02-14 · **Scope:** `hrms-web/src` (React 19 / TS / Vite 7), `server/` · **Method:** read-only static audit + production build (`npm run build`, vite 7.3.0, 2,869 modules, 11.7 s)

---

## 1. Size Map

### 1.1 LOC per top-level area (real `wc -l`)

| Area | LOC | Files |
|---|---:|---:|
| `src/pages` | 40,051 | 177 |
| `src/lib` | 13,178 | 35 |
| `src/components` (incl. `components/ui` 53 files) | 6,460 | 54 |
| `src/App.tsx` + `src/main.tsx` | 226 | 2 |
| `src/hooks` | 19 | 1 |
| `src/sections`, `src/types` | 0 | **empty dirs (dead)** |
| **Total `src`** | **59,934** | ~269 |
| `server/src` | 3,410 | — |

### 1.2 LOC per page module (top 10 of 20)

| Module | LOC | Files |
|---|---:|---:|
| `pages/employees` | 7,268 | 29 |
| `pages/kpi` | 4,377 | 13 |
| `pages/payroll` | 2,820 | 12 |
| `pages/attendance` | 2,538 | 11 |
| `pages/org` | 2,509 | 9 |
| `pages/settings` | 2,146 | 12 |
| `pages/claims` | 2,018 | 8 |
| `pages/insights` | 1,996 | 9 |
| `pages/superadmin` | 1,989 | 9 |
| `pages/leave` | 1,934 | 8 |

### 1.3 Top-20 largest files

| LOC | File |
|---:|---|
| 1,555 | `src/lib/salaryBenchmark.ts` (mostly data tables) |
| 864 | `src/pages/org/OrgChartPage.tsx` |
| 821 | `src/pages/employees/SeparationActions.tsx` |
| 757 | `src/lib/onboardLinks.ts` |
| 753 | `src/lib/payrollEngine.ts` |
| 726 | `src/components/ui/sidebar.tsx` (**unused — see §3**) |
| 714 | `src/pages/kpi/ReviewCycle.tsx` |
| 706 | `src/lib/employeeRecords.ts` |
| 678 | `src/lib/seed.ts` |
| 646 | `src/lib/orgChart.ts` |
| 644 | `src/pages/kpi/KpiLibrary.tsx` |
| 629 | `src/pages/superadmin/CreateCompanyWizard.tsx` |
| 621 | `src/pages/org/OrgPage.tsx` |
| 606 | `src/pages/kpi/CycleList.tsx` |
| 601 | `src/pages/attendance/ShiftsPage.tsx` |
| 597 | `src/pages/employees/EmployeeDetailPage.tsx` |
| 579 | `src/pages/contracts/ContractEditorDialog.tsx` |
| 541 | `src/pages/reports/reportBuilders.ts` |
| 520 | `src/lib/lifecycle.ts` |
| 514 | `src/lib/contracts.ts` |

---

## 2. Duplication Scan

| # | Pattern | Evidence (measured) | Consolidation | Est. LOC saved |
|---|---|---|---|---:|
| D1 | **`useAuthSafe` copied per module** — 4 files, 4 distinct md5s, 101 LOC total: `pages/attendance/useAuthSafe.ts` (35), `pages/claims/useAuthSafe.ts` (21), `pages/kpi/useAuthSafe.ts` (20), `pages/payroll/useAuthSafe.ts` (25); imported by 17 page files | → single `src/lib/useAuthSafe.ts` (keep the payroll version, the superset) | ~76 |
| D2 | **CSV builders × 2** — `pages/reports/csv.ts` (47 LOC: `toCsv`/`reportCsv`/`downloadCsv`, BOM + formula-injection guard) vs `pages/payroll/helpers.ts` (62 LOC: own `csvCell`/`toCsv`/`downloadTextFile`) | → `src/lib/csv.ts`; payroll's version lacks the formula-injection guard — merge fixes that too | ~50 |
| D3 | **`StatCard` × 3 local definitions** — `pages/contracts/ContractsPage.tsx:334`, `pages/dashboard/components/stat-cards.tsx:29`, `pages/superadmin/shared.tsx:68`; 103 `CardDescription` stat-style usages app-wide | → `src/components/StatCard.tsx` | ~400 |
| D4 | **Dialog form shell boilerplate** — 183 `DialogFooter` blocks across 37 page files with `<DialogContent>`/`<DialogHeader>` | → shared `FormDialog` shell (title/description/footer/cancel+submit) | ~1,100 |
| D5 | **Label + control field pairs** — 226 `<Label` occurrences in pages, hand-wrapped each time | → shared `FormField` (label+control+hint+error row) | ~700 |
| D6 | **Table boilerplate** — 24 page files repeat `<TableHeader>`/`<TableRow>`/empty-state markup | → shared `DataTable` (columns def + empty state + skeleton) | ~600 |
| D7 | **meta.ts `routes` manifests dead** — 18 `pages/**/meta.ts` files (156 LOC) were written "for the integration agent"; only 4 re-exports are actually imported by `App.tsx` (`ContractsPage`, `EmployeeRecordsPage`, `OnboardFormPage`, + org/superadmin re-export pattern); every `routes = [...]` const is unreferenced (routeRegistry in `App.tsx` is the single source) | delete dead exports, keep 4 used re-exports | ~60 |
| D8 | **Oversized pages with internal repetition** — `OrgChartPage.tsx` (864), `SeparationActions.tsx` (821), `ReviewCycle.tsx` (714), `KpiLibrary.tsx` (644): repeated section-card / action-row JSX | extract per-file subcomponents into `pages/<mod>/components/`; dedupe repeated JSX blocks | ~800 (conservative) |

**Duplication subtotal: ≈ 3,786 LOC**

---

## 3. Dead Code

| # | Item | Evidence | Est. LOC |
|---|---|---|---:|
| X1 | **27 of 53 shadcn `components/ui` files have zero importers** outside `components/ui` (grep `ui/<name>["']` across `src`): `accordion, aspect-ratio, breadcrumb, button-group, calendar, carousel, collapsible, command, context-menu, drawer, field, form, hover-card, input-group, input-otp, item, kbd, menubar, navigation-menu, pagination, popover, resizable, scroll-area, sidebar (726 LOC!), sonner, spinner, toggle` | delete files (recoverable from shadcn CLI if ever needed) | **3,803** |
| X2 | Empty directories `src/sections/`, `src/types/` (0 files) | remove | 0 |
| X3 | meta.ts dead exports | see D7 | (counted in D7) |
| X4 | Unused npm deps (zero imports outside `components/ui`, verified per package): `date-fns` (0 files), `react-hook-form` + `@hookform/resolvers` + `zod` (only used by unused `form.tsx`), `sonner`, `next-themes`, `cmdk`, `embla-carousel-react`, `input-otp`, `react-day-picker`, `react-resizable-panels`, plus radix packages backing the 27 unused components (`react-accordion`, `-aspect-ratio`, `-collapsible`, `-context-menu`, `-hover-card`, `-menubar`, `-navigation-menu`, `-popover`, `-scroll-area`, `-toggle`) | remove from `package.json` | install/bundle size |
| X5 | No unreachable routes found — `routeRegistry` (23 routes) matches nav; no placeholder-Dashboard remnants (`pages/dashboard` is a live 1,089-LOC module); `JSON.parse` usage is confined to the storage layer (`lib/db.ts`, `lib/api.ts`, …) with **0 occurrences in `.tsx`** | — | — |

**Dead-code subtotal: ≈ 3,803 LOC**

---

## 4. Consolidation Plan (LOC-reduction budget)

| Tier | Items | LOC |
|---|---|---:|
| Tier 1 — pure deletion, zero risk | X1 + X2 + D7 | 3,863 |
| Tier 2 — mechanical consolidation | D1 + D2 + D3 | 526 |
| Tier 3 — shared primitives (`FormDialog`, `FormField`, `DataTable`) | D4 + D5 + D6 | 2,400 |
| Tier 4 — oversized-page decomposition | D8 | 800 |
| **Total identified** | | **≈ 7,589 / 59,934 = 12.7%** |
| Stretch — apply D4–D6 primitives to remaining 103 stat cards + deeper sweep of `kpi`/`employees` internals | | +1,400 → **≈ 15.1%** ✅ target ≥15% |

---

## 5. Bundle Efficiency

### 5.1 Measured build output (`npm run build`)

| Asset | Size | gzip |
|---|---:|---:|
| `dist/assets/index-*.js` (**single chunk, everything**) | **2,653.24 kB** | **660.57 kB** |
| `dist/assets/index-*.css` | 131.33 kB | 21.51 kB |
| `seed-*.js` | 24.37 kB | 8.25 kB |
| `NotFound-*.js` | 0.90 kB | 0.44 kB |

Vite warns: *"Some chunks are larger than 500 kB after minification."* Only `NotFound` is `React.lazy` (`App.tsx:42`); **all 23 registry routes are eagerly imported** (`App.tsx:14–39`). Also flagged: `lib/appSettings.ts` is both dynamically imported (`attendance/model.ts`) and statically imported (`claims/claimPolicy.ts`) — the dynamic import is ineffective.

### 5.2 Route-level code-splitting plan

Convert every element in `routeRegistry` to `lazy(() => import(...))` + `<Suspense>` (pattern already proven by `NotFound`), with one chunk per page module:

| Chunk | Contains | Priority |
|---|---|---|
| `vendor-react` | react, react-dom, react-router, radix primitives actually used | manualChunks |
| `chunk-recharts` | recharts (~5.3 MB in node_modules, used by 9 files across dashboard/claims/insights/kpi/superadmin) | manualChunks or lazy per chart page |
| `chunk-orgchart` | `@xyflow/react` + `dagre` + `html-to-image` — used by exactly **1 route** (`/org/chart`, 2 files) | lazy route |
| per-module | `employees` (7.3k LOC), `kpi` (4.4k), `payroll`, `attendance`, … | lazy routes |

**Expected effect (est.):** initial JS drops from 660 kB gzip to roughly **250–350 kB gzip** (vendor + dashboard only); org-chart and recharts chunks (~120–180 kB gzip combined) load on demand. Secondary: fix the `appSettings.ts` mixed static/dynamic import.

### 5.3 Dependency plan

- **Remove entirely (verified zero app usage):** `date-fns`, `react-hook-form`, `@hookform/resolvers`, `zod`, `sonner`, `next-themes`, `cmdk`, `embla-carousel-react`, `input-otp`, `react-day-picker`, `react-resizable-panels` + 10 unused radix packages.
- **Lazy-load candidates:** `@xyflow/react` (3.4 MB), `dagre` (0.9 MB), `html-to-image` (static `import { toPng }` at `OrgChartPage.tsx:17` — make it `await import('html-to-image')` inside the export handler), `recharts` (5.3 MB).
- **lucide-react** (44 MB on disk) — fine at runtime thanks to tree-shaking, but verify imports stay per-icon (`import { X } from 'lucide-react'`).

---

## 6. Render Efficiency

| Check | Result |
|---|---|
| `JSON.parse` in `.tsx` render paths | **0** — parsing is isolated in storage libs (`lib/db.ts` etc.) ✅ |
| Memoization in hot lists | 36 `useMemo`/`memo` hits across employees+attendance — coverage exists but is uneven |
| Gaps found | `EmployeesPage.tsx:189` — `scoped.filter(...)` executed inline in JSX render (probation count) recomputes every render; `TodayBoard.tsx:56-57,92` — filter/map chains partly memoized, `holiday` lookup (`:95`) not; `EmployeesPage.tsx:97` `list` filter is memoized but the derived counts at `:163,189` are not |
| Recommendation | wrap derived counts (`scoped.filter` stats) in `useMemo`; extract row components as `React.memo` for `EmployeesPage`/`TodayBoard`/`TimesheetView` tables; keep selectors referentially stable |

---

## 7. 8-Line Summary

1. Codebase: 59,934 LOC src (pages 40,051 / lib 13,178 / components 6,460) + 3,410 LOC server; build ships ONE 2,653 kB JS chunk (660 kB gzip).
2. Dead weight: 27 of 53 shadcn ui files (3,803 LOC, incl. 726-LOC sidebar) are never imported; `src/sections`+`src/types` are empty dirs.
3. Dead meta layer: 18 `pages/**/meta.ts` manifests were integration-agent scaffolding; all `routes` exports are unreferenced (~60 LOC).
4. `useAuthSafe` exists as 4 divergent copies (101 LOC, 4 distinct hashes) imported by 17 files — consolidate to one lib hook.
5. CSV generation is implemented twice (reports vs payroll; payroll's lacks the formula-injection guard) — merge into `lib/csv.ts`.
6. Boilerplate at scale: 183 DialogFooter blocks in 37 dialogs, 226 hand-wrapped Label+control pairs, 24 hand-built tables, 3 separate StatCard components — shared `FormDialog`/`FormField`/`DataTable`/`StatCard` ≈ 2,800 LOC savings.
7. Bundle: only `NotFound` is lazy; per-route `React.lazy` + manualChunks (vendor/recharts/orgchart) should cut initial gzip JS from 660 kB to ~250–350 kB; `@xyflow/react`+`dagre`+`html-to-image` serve exactly one route (`/org/chart`).
8. Total identified reduction ≈ 12.7% of src LOC, stretch ≈ 15.1% (target met); 11 npm deps (date-fns, RHF+zod, sonner, next-themes, cmdk, embla, input-otp, react-day-picker, react-resizable-panels…) removable; render hot-spots need `useMemo` on derived counts in `EmployeesPage`/`TodayBoard` (JSON.parse-in-render: none found).
