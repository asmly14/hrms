/**
 * M10 Organization module manifest — consumed by the integration agent when
 * wiring src/App.tsx (routeRegistry + nav). Do not import from inside the module.
 *
 * Suggested RouteDef wiring:
 *   { path: '/org',       title: 'Organization', element: <OrgPage />,      roles: ['Admin', 'HR'] }
 *   { path: '/org/chart', title: 'Org Chart',    element: <OrgChartPage />, roles: ['Admin', 'HR'] }
 */
export { default as OrgPage } from './OrgPage';
export { default as OrgChartPage } from './OrgChartPage';

export const routes = [
  { path: '/org', title: 'Organization' },
  { path: '/org/chart', title: 'Org Chart' },
];
