/**
 * Share helpers for onboarding invite links — clipboard (with legacy
 * fallback), WhatsApp and mailto share targets.
 */

/** Copy text to the clipboard; falls back to execCommand for older browsers
 *  / non-secure contexts. Returns true on success. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function shareMessage(label: string, url: string): string {
  return (
    `Hi ${label}, welcome aboard! Please complete your onboarding form here: ${url}\n\n` +
    `It takes about 10 minutes — you'll need your NRIC, bank details and supporting documents (IC copy, certificates, CV, bank statement, photo).`
  );
}

export function whatsAppShareUrl(label: string, url: string): string {
  return `https://wa.me/?text=${encodeURIComponent(shareMessage(label, url))}`;
}

export function mailtoShareUrl(label: string, url: string): string {
  const subject = `Your onboarding form — action needed`;
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(
    shareMessage(label, url),
  )}`;
}
