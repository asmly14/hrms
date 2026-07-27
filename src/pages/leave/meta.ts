/**
 * M4 Leave + Holidays module manifest (read by the integration agent).
 * Page components are re-exported for route wiring; the integration agent
 * owns src/App.tsx.
 */
export { default as LeavePage } from './LeavePage';
export { default as HolidaysPage } from '../holidays/HolidaysPage';

export const routes = [
  { path: '/leave', title: 'Leave' },
  { path: '/holidays', title: 'Public Holidays' },
];
