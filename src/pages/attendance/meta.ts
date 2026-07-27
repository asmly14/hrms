/**
 * Route manifest for the integration agent (Stage 5 wiring).
 * Pages live in this folder; App.tsx must map:
 *   /attendance        → AttendancePage
 *   /attendance/shifts → ShiftsPage
 */
export const routes = [
  { path: '/attendance', title: 'Attendance' },
  { path: '/attendance/shifts', title: 'Shifts' },
];
