/**
 * Toast helper — the single import point for user-feedback toasts.
 *
 * The app-level `<Toaster />` is mounted in App.tsx. Module/page agents should
 * import from here (not from 'sonner' directly) so feedback stays consistent:
 *
 *   import { toast, toastSuccess, toastError } from '@/lib/toast';
 *
 *   toastSuccess('Run finalized');
 *   toastError('Could not finalize run', err);
 *
 * `toast` is re-exported verbatim for cases needing full control (promise
 * toasts, custom durations, …); the wrappers cover the common cases and strip
 * technical noise (stack traces, `TypeError:` prefixes, oversized blobs) out
 * of what the user sees.
 */
import { toast } from 'sonner';

export { toast };

/** Longest error detail we will show a user before truncating. */
const MAX_DETAIL = 140;

/**
 * Reduce an unknown thrown value to one clean, human-readable line.
 * Returns undefined when there is nothing worth showing (nullish input,
 * empty message, '[object Object]'-style junk).
 */
export function cleanErrorMessage(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  let msg: string;
  if (typeof error === 'string') msg = error;
  else if (error instanceof Error) msg = error.message;
  else msg = String(error);
  // First line only — drops stack frames and multi-line dumps.
  msg = (msg.split('\n')[0] ?? '').trim();
  // Strip noisy JS error-type prefixes.
  msg = msg.replace(/^(error|typeerror|referenceerror|syntaxerror|rangeerror|urierror|evalerror):\s*/i, '');
  if (!msg || msg === '[object Object]' || msg === 'undefined' || msg === 'null') return undefined;
  if (msg.length > MAX_DETAIL) return `${msg.slice(0, MAX_DETAIL - 1)}…`;
  return msg;
}

/** Success toast; optional plain-language description. */
export function toastSuccess(title: string, description?: string): void {
  toast.success(title, description ? { description } : undefined);
}

/**
 * Error toast. `error` may be a string, an Error, or anything thrown — its
 * cleaned message becomes the description; omit it for a bare title.
 */
export function toastError(title: string, error?: unknown): void {
  const detail = cleanErrorMessage(error);
  toast.error(title, detail ? { description: detail } : undefined);
}

/** Info toast; optional plain-language description. */
export function toastInfo(title: string, description?: string): void {
  toast.info(title, description ? { description } : undefined);
}
