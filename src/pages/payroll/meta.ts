/**
 * M6 Payroll module — route manifest for the integration agent.
 */
export const routes = [
  { path: '/payroll', title: 'Payroll' },
  { path: '/payroll/runs/:id', title: 'Payroll Run' },
  { path: '/payroll/payslip/:id', title: 'Payslip' },
  // Employee self-service — nav item 'My Payslips' should be visible to ALL
  // roles (page component: default export of ./MyPayslipsPage.tsx).
  { path: '/my-payslips', title: 'My Payslips' },
];
