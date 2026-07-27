/**
 * M8 module routes — consumed by the integration agent when wiring App.tsx.
 * This file is the canonical route list for the whole M8 module
 * (insights + reports); reports/meta.ts carries its own route too.
 */
export const routes = [
  { path: '/insights/salary', title: 'Salary Insights' },
  { path: '/reports', title: 'Reports' },
];
