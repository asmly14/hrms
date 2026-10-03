/**
 * One-time credential toast — the ONLY place a plaintext password is surfaced
 * after create/reset (demo auth has no e-mail/SMS channel; the admin copies
 * the credentials and shares them out-of-band). Long duration so it can be
 * transcribed; the password is never persisted or audit-logged.
 */
import { toast } from '@/lib/toast';

export function toastAccountCredentials(title: string, username: string, password: string): void {
  toast.success(title, {
    description: `Username: ${username} · Password: ${password} — share these securely; shown only once.`,
    duration: 15000,
  });
}
