/**
 * State + save-procedure helpers for the 'Login account' sub-form (component
 * lives in AccountFields.tsx — react-refresh requires component-only exports
 * in .tsx modules).
 *
 * Save procedure (per spec): the EMPLOYEE is saved first, then the account is
 * attempted. Account failures (e.g. duplicate username) surface as a
 * toast.error and never roll back the employee save.
 */
import { useState } from 'react';
import { toast } from '@/lib/toast';
import { createUserAccount, suggestUsername, type AuthRole, type ManagedRole } from '@/lib/auth';
import { toastAccountCredentials } from '@/components/auth/accountToast';

export interface AccountFormState {
  enabled: boolean;
  username: string;
  /** True once the user edits the username manually (stops email auto-sync). */
  usernameTouched: boolean;
  password: string;
  showPassword: boolean;
  role: ManagedRole;
}

export function emptyAccountForm(): AccountFormState {
  return { enabled: false, username: '', usernameTouched: false, password: '', showPassword: false, role: 'Employee' };
}

/**
 * Owns the account sub-form state and keeps the username synced to the
 * employee email's prefix until the user edits it manually. Render-phase
 * adjust (same pattern as the wizard's prevOpen reset) — no effects.
 */
export function useAccountForm(email: string, companyCode?: string) {
  const [account, setAccount] = useState<AccountFormState>(emptyAccountForm());
  const [prevEmail, setPrevEmail] = useState(email);
  if (email !== prevEmail) {
    setPrevEmail(email);
    if (account.enabled && !account.usernameTouched) {
      setAccount((a) => ({ ...a, username: suggestUsername(email, companyCode) }));
    }
  }
  const patchAccount = (p: Partial<AccountFormState>) => setAccount((a) => ({ ...a, ...p }));
  const resetAccount = () => {
    setAccount(emptyAccountForm());
    setPrevEmail(email);
  };
  return { account, patchAccount, resetAccount };
}

/**
 * Attempt account creation AFTER the employee was saved. Success → one-time
 * credentials toast; failure → error toast that explicitly notes the employee
 * record WAS saved. Returns the raw createUserAccount result.
 */
export function attemptAccountCreation(
  account: AccountFormState,
  companyId: string,
  employeeId: string,
  actorName: string,
): ReturnType<typeof createUserAccount> {
  const username = account.username.trim().toLowerCase();
  const result = createUserAccount(
    { username, password: account.password, role: account.role as AuthRole, companyId, employeeId },
    actorName,
  );
  if (result.ok) {
    toastAccountCredentials('Login account created', username, account.password);
  } else {
    toast.error('Employee saved, but the login account was not created.', { description: result.error });
  }
  return result;
}
