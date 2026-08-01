/**
 * Public onboarding form manifest — consumed by the integration agent.
 *
 * MOUNT OUTSIDE THE AUTH GUARD, mirroring /login in src/App.tsx:
 *
 *     import { OnboardFormPage } from '@/pages/onboard/meta';
 *     …
 *     <Route path="/login" element={<LoginPage />} />
 *     <Route path="/onboard/:token" element={<OnboardFormPage />} />   ← public
 *     <Route element={<RequireAuth />}>…</Route>
 *
 * The page needs no AuthProvider/TenantProvider state: it resolves the
 * company (read-only branding + org data) from the link token itself.
 */
export { default as OnboardFormPage } from './OnboardFormPage';

export const routes = [{ path: '/onboard/:token', title: 'Onboarding Form', public: true }];
