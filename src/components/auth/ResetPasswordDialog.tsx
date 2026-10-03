/**
 * ResetPasswordDialog — Admin resets an account's password. On success the new
 * password is shown ONCE (dialog + one-time toast); the audit trail records
 * the reset without the password.
 */
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from '@/lib/toast';
import { resetUserPassword, validatePassword, type PublicUser } from '@/lib/auth';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { PasswordField } from './PasswordField';
import { toastAccountCredentials } from './accountToast';

export interface ResetPasswordDialogProps {
  /** The account being reset (null while closed). */
  account: PublicUser | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actorName: string;
}

export function ResetPasswordDialog({ account, open, onOpenChange, actorName }: ResetPasswordDialogProps) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Reset on the open edge (render-phase adjust — no effect).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setPassword('');
      setShowPassword(false);
      setError(null);
      setDone(false);
    }
  }

  const submit = () => {
    if (!account) return;
    const pwError = validatePassword(password);
    if (pwError) {
      setError(pwError);
      return;
    }
    const result = resetUserPassword(account.id, password, actorName);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDone(true);
    toastAccountCredentials(`Password reset for ${account.username}`, account.username, password);
  };

  const copyPassword = async () => {
    try {
      await navigator.clipboard.writeText(password);
      toast.success('Password copied');
    } catch {
      toast.error('Could not access the clipboard — copy the password manually.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{done ? 'Password reset' : 'Reset password'}</DialogTitle>
          <DialogDescription>
            {done ? (
              'Share the new password securely — it is shown only once.'
            ) : (
              <>
                Set a new password for <code className="rounded bg-muted px-1 py-0.5">{account?.username}</code>. The
                old password stops working immediately.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <>
            <div className="flex items-center justify-between gap-2 rounded-lg border border-lime-200 bg-lime-50/60 p-4 dark:border-lime-900 dark:bg-lime-950/30">
              <span className="text-sm text-muted-foreground">New password</span>
              <code className="rounded bg-background px-1.5 py-0.5 text-sm font-medium">{password}</code>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={copyPassword}>
                <Copy className="mr-1.5 h-4 w-4" /> Copy
              </Button>
              <Button onClick={() => onOpenChange(false)}>
                <Check className="mr-1.5 h-4 w-4" /> Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="py-1">
              <PasswordField
                id="rp-password"
                label="New password"
                value={password}
                onChange={setPassword}
                show={showPassword}
                onToggleShow={setShowPassword}
              />
              {error && (
                <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
                  {error}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={!password}>
                Reset password
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
