/**
 * Shared password field for account dialogs/forms: type-to-enter with a
 * generate button (crypto-random readable password) and a show/hide toggle.
 */
import { Eye, EyeOff, RefreshCw } from 'lucide-react';
import { generatePassword } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface PasswordFieldProps {
  id: string;
  label?: string;
  value: string;
  onChange: (value: string) => void;
  show: boolean;
  onToggleShow: (show: boolean) => void;
  error?: string;
  hint?: string;
}

export function PasswordField({ id, label = 'Password', value, onChange, show, onToggleShow, error, hint }: PasswordFieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            id={id}
            type={show ? 'text' : 'password'}
            className="rounded-lg pr-9 font-mono"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Min. 6 characters"
            autoComplete="new-password"
          />
          <button
            type="button"
            aria-label={show ? 'Hide password' : 'Show password'}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            onClick={() => onToggleShow(!show)}
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <Button type="button" variant="outline" onClick={() => { onChange(generatePassword()); onToggleShow(true); }}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Generate
        </Button>
      </div>
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
      {!error && hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
