/**
 * Settings → Integrations: per-company DeepSeek API key powering AI receipt
 * scanning in e-Claims (lib/ocr.ts + claims/ClaimFormDialog).
 *
 * The key is a COMPANY secret stored tenant-scoped in the 'ext:integrations'
 * settings doc — the same extension-doc convention as 'ext:payroll' /
 * 'ext:leaveTopups'. It is displayed only masked ('sk-…last4'), audited only
 * masked, and leaves the browser solely as the Authorization header on direct
 * requests to api.deepseek.com. Nothing is ever committed to code or seeds.
 */
import { useState } from 'react';
import {
  CheckCircle2, Eye, EyeOff, KeyRound, Loader2, ScanLine, ShieldCheck, Trash2, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { logAudit, useCollection } from '@/lib/db';
import {
  getDeepSeekApiKey, INTEGRATIONS_DOC_ID, maskApiKey, OcrError, saveDeepSeekApiKey,
  testDeepSeekConnection,
} from '@/lib/ocr';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DEMO_ACTOR, Field, SaveButton, SectionCard } from '../shared';

/** Row shape for the reactive 'settings' read (id + free-form doc fields). */
interface SettingsRow {
  id: string;
  kind?: string;
  [key: string]: unknown;
}

interface TestOutcome {
  ok: boolean;
  text: string;
}

export default function IntegrationsSection() {
  // Subscribes this section to the tenant's settings collection so the masked
  // display re-reads immediately after Save / Remove (writes notify here).
  useCollection<SettingsRow>('settings');
  const savedKey = getDeepSeekApiKey();

  const [draft, setDraft] = useState('');
  const [show, setShow] = useState(false);
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);

  const dirty = draft.trim().length > 0;
  const keyToTest = draft.trim() || savedKey || '';

  function onSave() {
    const clean = draft.trim();
    if (!clean) return;
    saveDeepSeekApiKey(clean);
    logAudit({
      actorName: DEMO_ACTOR,
      action: 'settings.integrations.save',
      entity: 'settings',
      entityId: INTEGRATIONS_DOC_ID,
      detail: `DeepSeek API key saved (${maskApiKey(clean)})`,
    });
    toast.success('DeepSeek API key saved for this company');
    setDraft('');
    setShow(false);
    setOutcome(null);
  }

  function onRemove() {
    saveDeepSeekApiKey(null);
    logAudit({
      actorName: DEMO_ACTOR,
      action: 'settings.integrations.remove',
      entity: 'settings',
      entityId: INTEGRATIONS_DOC_ID,
      detail: 'DeepSeek API key removed',
    });
    toast.success('DeepSeek API key removed — AI receipt extraction is now disabled');
    setDraft('');
    setOutcome(null);
  }

  async function onTest() {
    if (!keyToTest) return;
    setTesting(true);
    setOutcome(null);
    try {
      const { models } = await testDeepSeekConnection(keyToTest);
      const model = models.includes('deepseek-flash')
        ? 'deepseek-flash'
        : (models[0] ?? 'deepseek-flash');
      setOutcome({ ok: true, text: `Connected — ${model} available for receipt scanning.` });
    } catch (err) {
      setOutcome({
        ok: false,
        text:
          err instanceof OcrError
            ? err.message
            : 'Connection failed — check the network and try again.',
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionCard
        icon={KeyRound}
        title="DeepSeek receipt scanning (AI)"
        description="One API key per company powers 'Extract with AI' on the claim form — a receipt photo becomes editable merchant, date, amount and category fields."
        action={<SaveButton onSave={onSave} disabled={!dirty} />}
      >
        {savedKey && !dirty ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="border-lime-300 bg-lime-50 text-lime-800 dark:border-lime-700 dark:bg-lime-950/40 dark:text-lime-300">
              Configured
            </Badge>
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{maskApiKey(savedKey)}</code>
            <span className="text-xs text-muted-foreground">
              Saved for this company. Type a new key below to rotate it.
            </span>
          </div>
        ) : null}

        <Field
          label="DeepSeek API key"
          hint="Create a key at platform.deepseek.com — usage is billed to your own DeepSeek account."
        >
          <div className="relative max-w-md">
            <Input
              type={show ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder={savedKey ? maskApiKey(savedKey) : 'sk-…'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="pr-10 font-mono text-sm"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="absolute inset-y-0 right-0 inline-flex w-9 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
              aria-label={show ? 'Hide API key' : 'Show API key'}
            >
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={testing || !keyToTest}
            onClick={() => void onTest()}
          >
            {testing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ScanLine className="h-3.5 w-3.5" />
            )}
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
          {savedKey ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-red-600 hover:text-red-700"
              onClick={onRemove}
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove key
            </Button>
          ) : null}
        </div>

        {outcome ? (
          <p
            className={
              outcome.ok
                ? 'flex items-center gap-1.5 text-sm text-lime-700 dark:text-lime-400'
                : 'flex items-center gap-1.5 text-sm text-red-600 dark:text-red-400'
            }
          >
            {outcome.ok ? (
              <CheckCircle2 className="h-4 w-4 shrink-0" />
            ) : (
              <XCircle className="h-4 w-4 shrink-0" />
            )}
            {outcome.text}
          </p>
        ) : null}

        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
          The key is stored in this browser for your company only — never sent anywhere except
          api.deepseek.com. It is never logged and appears only masked (sk-…last4) on this screen.
        </p>
      </SectionCard>

      <SectionCard
        icon={ScanLine}
        title="How receipt scanning works"
        description="Claims → New claim → Receipt & AI scan."
      >
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Upload a receipt photo — or use the camera on mobile (<code className="rounded bg-muted px-1 py-0.5">capture=&quot;environment&quot;</code>).</li>
          <li>The photo is downscaled and stored against the claim (700 KB document cap applies).</li>
          <li><span className="font-medium text-foreground">Extract with AI</span> sends it to DeepSeek and prefills merchant, date, amount, currency and category.</li>
          <li>Every field stays editable — the draft carries an <span className="font-medium text-foreground">AI-extracted</span> badge until submitted.</li>
        </ol>
      </SectionCard>
    </div>
  );
}
