/**
 * SuperAdmin console manifest. The integration agent wires the '/superadmin'
 * route into App.tsx's routeRegistry; the page self-guards on
 * useAuth().isSuperAdmin, so no route-level role mapping is strictly required
 * (adding roles: ['Admin'] is harmless — SuperAdmin maps to Admin in guards,
 * and company Admins still hit the in-page restricted notice).
 */
export { default as SuperAdminPage } from './SuperAdminPage';

export const routes = [{ path: '/superadmin', title: 'Super Admin' }];
