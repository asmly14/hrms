/**
 * Company Setup — route manifest for the integration agent.
 * Contract: docs/architecture.md (routes are wired into App.tsx ONLY by the
 * integration agent). Do not import this from inside the module.
 */
import CompanyPage from './CompanyPage';

export const routes = [{ path: '/company', title: 'Company Setup' }];

export default CompanyPage;
