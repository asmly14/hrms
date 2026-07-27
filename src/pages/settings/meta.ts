/**
 * M9 Settings — route manifest for the integration agent.
 * Contract: docs/architecture.md (routes are wired into App.tsx ONLY by the
 * integration agent in Stage 5).
 */
import SettingsPage from './SettingsPage';

export const routes = [{ path: '/settings', title: 'Settings' }];

export default SettingsPage;
