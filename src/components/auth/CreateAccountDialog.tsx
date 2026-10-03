/**
 * CreateAccountDialog — Admin creates a login account for the ACTIVE company.
 * Shared by Settings → Users and the employee-detail quick action.
 *
 * Flow: pick employee (accounts-less first; standalone allowed) → username is
 * suggested from the email prefix (editable, live uniqueness hint) → password
 * (generate or type, show/hide) → role (default Employee). On success the
 * credentials are shown ONCE inside the dialog (and via a one-time toast) —
 * they are never retrievable afterwards (bcrypt at rest).
 */
import { useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from '@/lib/toast';
import {
  createUserAccount,
  findUser,
  suggestUsername,
  validatePassword,
  validateUsername,
  type AuthRole,
  type ManagedRole,
  type PublicUser,
} from '@/lib/auth';
import type { Employee } from '@/lib/types';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PasswordField } from './PasswordField';
import { toastAccountCredentials } from './accountToast';

const NONE = '__none__';

const ROLE_OPTIONS: ManagedRole[] = ['Employee', 'Manager', 'HR', 'Admin'];

export interface CreateAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Tenant the account belongs to. */
  companyId: string;
  /** Company code — used to namespace suggested usernames on collision. */
  companyCode?: string;
  /** Employees of the active company (picker source). */
  employees: Employee[];
  /** Accounts already linked to employees (deprioritized in the picker). */
  existingAccounts?: PublicUser[];
  /** Lock the picker to this employee (employee-detail quick action). */
  fixedEmployeeId?: string;
  actorName: string;
  onCreated?: (user: PublicUser) => void;
}

export function CreateAccountDialog({
  open,
  onOpenChange,
  companyId,
  companyCode,
  employees,
  existingAccounts = [],
  fixedEmployeeId,
  actorName,
  onCreated,
}: CreateAccountDialogProps) {
  const [employeeId, setEmployeeId] = useState<string>(fixedEmployeeId ?? NONE);
  const [username, setUsername] = useState('');
  const [usernameTouched, setUsernameTouched] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState<ManagedRole>('Employee');
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ username: string; password: string } | null>(null);

  // Reset on the open edge (render-phase adjust — no effect).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      const initialEmp = fixedEmployeeId ?? NONE;
      setEmployeeId(initialEmp);
      setUsernameTouched(false);
      const emp = fixedEmployeeId ? employees.find((e) => e.id === fixedEmployeeId) : undefined;
      setUsername(emp ? suggestUsername(emp.email, companyCode) : '');
      setPassword('');
      setShowPassword(false);
      setRole('Employee');
      setError(null);
      setCreated(null);
    }
  }

  const linkedEmployeeIds = useMemo(
    () => new Set(existingAccounts.map((a) => a.employeeId).filter((x): x is string => !!x)),
    [existingAccounts],
  );

  // Picker: employees without accounts first, then the rest (marked), A→Z.
  const pickerEmployees = useMemo(() => {
    const sorted = [...employees].sort((a, b) => a.name.localeCompare(b.name));
    return [
      ...sorted.filter((e) => !linkedEmployeeIds.has(e.id)),
      ...sorted.filter((e) => linkedEmployeeIds.has(e.id)),
    ];
  }, [employees, linkedEmployeeIds]);

  const pickEmployee = (id: string) => {
    setEmployeeId(id);
    if (!usernameTouched) {
      const emp = employees.find((e) => e.id === id);
      setUsername(emp ? suggestUsername(emp.email, companyCode) : '');
    }
  };

  // Live (non-blocking) hints under the fields.
  const trimmedUsername = username.trim().toLowerCase();
  const usernameHint =
    trimmedUsername === ''
      ? null
      : validateUsername(trimmedUsername) ??
        (findUser(trimmedUsername) ? 'This username is already taken.' : null);

  const submit = () => {
    const unameError = validateUsername(trimmedUsername);
    if (unameError) {
      setError(unameError);
      return;
    }
    const pwError = validatePassword(password);
    if (pwError) {
      setError(pwError);
      return;
    }
    const result = createUserAccount(
      {
        username: trimmedUsername,
        password,
        role: role as AuthRole,
        companyId,
        employeeId: employeeId === NONE ? undefined : employeeId,
      },
      actorName,
    );
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCreated({ username: trimmedUsername, password });
    toastAccountCredentials('Account created', trimmedUsername, password);
    onCreated?.(result.user);
  };

  const copyCredentials = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(`Username: ${created.username}\nPassword: ${created.password}`);
      toast.success('Credentials copied');
    } catch {
      toast.error('Could not access the clipboard — copy the details manually.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{created ? 'Account created' : 'Create login account'}</DialogTitle>
          <DialogDescription>
            {created
              ? 'Share these credentials securely — they are shown only once and cannot be retrieved later.'
              : 'Creates sign-in access only — no employee record is changed.'}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <>
            <div className="space-y-2 rounded-lg border border-lime-200 bg-lime-50/60 p-4 dark:border-lime-900 dark:bg-lime-950/30">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">Username</span>
                <code className="rounded bg-background px-1.5 py-0.5 text-sm font-medium">{created.username}</code>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">Password</span>
                <code className="rounded bg-background px-1.5 py-0.5 text-sm font-medium">{created.password}</code>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">Role</span>
                <span className="text-sm font-medium">{role}</span>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={copyCredentials}>
                <Copy className="mr-1.5 h-4 w-4" /> Copy
              </Button>
              <Button onClick={() => onOpenChange(false)}>
                <Check className="mr-1.5 h-4 w-4" /> Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="space-y-4 py-1">
              {fixedEmployeeId ? (
                <p className="rounded-lg bg-muted px-3 py-2 text-sm">
                  For{' '}
                  <span className="font-medium">
                    {employees.find((e) => e.id === fixedEmployeeId)?.name ?? 'this employee'}
                  </span>
                </p>
              ) : (
                <div className="space-y-1.5">
                  <Label>Link to employee</Label>
                  <Select value={employeeId} onValueChange={pickEmployee}>
                    <SelectTrigger className="rounded-lg">
                      <SelectValue placeholder="Select employee" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>No linked employee (standalone)</SelectItem>
                      {pickerEmployees.map((e) => (
                        <SelectItem key={e.id} value={e.id}>
                          {e.name} · {e.email}
                          {linkedEmployeeIds.has(e.id) ? ' (has account)' : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Employees without a login account are listed first.
                  </p>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="ca-username">Username</Label>
                <Input
                  id="ca-username"
                  className="rounded-lg font-mono"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    setUsernameTouched(true);
                  }}
                  placeholder="e.g. aisha.rahman"
                  autoComplete="off"
                />
                {usernameHint ? (
                  <p className="text-xs text-red-600">{usernameHint}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Auto-suggested from the email prefix — editable. Usernames are global across companies.
                  </p>
                )}
              </div>

              <PasswordField
                id="ca-password"
                value={password}
                onChange={setPassword}
                show={showPassword}
                onToggleShow={setShowPassword}
                hint="Use Generate for a strong temporary password — the employee should change it later."
              />

              <div className="space-y-1.5">
                <Label>Access role</Label>
                <Select value={role} onValueChange={(v) => setRole(v as ManagedRole)}>
                  <SelectTrigger className="rounded-lg">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLE_OPTIONS.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={!trimmedUsername || !password || !!usernameHint}>
                Create account
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
