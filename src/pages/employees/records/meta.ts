/**
 * Employee Records module manifest (read by the Stage-5 integration agent).
 * Mount under the Employees section; link from EmployeeDetailPage and the
 * directory row actions as "Records".
 */
export { default as EmployeeRecordsPage } from './EmployeeRecordsPage';

export const routes = [{ path: '/employees/:id/records', title: 'Employee Records' }];
