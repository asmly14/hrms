/**
 * 'Login account' section shared by the Add employee dialog and the New-Hire
 * wizard. Collapsed by default behind a toggle; when enabled it collects
 * username (auto-suggested from the email prefix until manually edited),
 * password (generate / show-hide) and role (default Employee).
 *
 * Live hints under the fields are intentionally NON-blocking: the employee
 * save must never be trapped by the optional account (state + save procedure
 * live in ./accountForm.ts).
 */
import { findUser, validatePassword, validateUsername, suggestUsername, type ManagedRole } from '@/lib/auth';
import { PasswordField } from '@/components/auth/PasswordField';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { AccountFormState } from './accountForm';

interface AccountFieldsProps {
  account: AccountFormState;
  patchAccount: (patch: Partial<AccountFormState>) => void;
  /** Employee email — drives the username suggestion. */
  email: string;
  companyCode?: string;
}

export function AccountFields({ account, patchAccount, email, companyCode }: AccountFieldsProps) {
  const usernameError =
    account.enabled && account.username.trim() !== ''
      ? validateUsername(account.username) ??
        (findUser(account.username.trim().toLowerCase()) ? 'This username is already taken.' : null)
      : null;
  const passwordError =
    account.enabled && account.password !== '' ? validatePassword(account.password) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <Label htmlFor="f-account" className="cursor-pointer">
            Create login account
          </Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Gives the employee sign-in access on day one. Credentials are shown once — share them securely.
          </p>
        </div>
        <Switch
          id="f-account"
          checked={account.enabled}
          onCheckedChange={(v) =>
            patchAccount({
              enabled: v,
              // Pre-fill the suggestion the moment the section is switched on.
              ...(v && !account.username && email.trim()
                ? { username: suggestUsername(email, companyCode), usernameTouched: false }
                : {}),
            })
          }
        />
      </div>

      {account.enabled && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="f-acc-username">Username</Label>
            <Input
              id="f-acc-username"
              className="rounded-lg font-mono"
              value={account.username}
              onChange={(e) => patchAccount({ username: e.target.value, usernameTouched: true })}
              placeholder="e.g. aisha.rahman"
              autoComplete="off"
            />
            {usernameError ? (
              <p className="text-xs text-red-600">{usernameError}</p>
            ) : (
              <p className="text-xs text-muted-foreground">From the email prefix — editable; globally unique.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Access role</Label>
            <Select value={account.role} onValueChange={(v) => patchAccount({ role: v as ManagedRole })}>
              <SelectTrigger className="rounded-lg">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Employee">Employee</SelectItem>
                <SelectItem value="Manager">Manager</SelectItem>
                <SelectItem value="HR">HR</SelectItem>
                <SelectItem value="Admin">Admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-2">
            <PasswordField
              id="f-acc-password"
              value={account.password}
              onChange={(v) => patchAccount({ password: v })}
              show={account.showPassword}
              onToggleShow={(v) => patchAccount({ showPassword: v })}
              error={passwordError ?? undefined}
              hint={account.password === '' ? 'Leave empty to skip — no account is created without a password.' : undefined}
            />
          </div>
        </div>
      )}
    </div>
  );
}
