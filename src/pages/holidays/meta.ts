/**
 * Public Holidays page manifest (M4). The full module manifest — both routes —
 * lives in ../leave/meta.ts; this file satisfies the per-folder contract.
 */
export { default as HolidaysPage } from './HolidaysPage';

export const routes = [{ path: '/holidays', title: 'Public Holidays' }];
