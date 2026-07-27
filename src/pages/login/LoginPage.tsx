/**
 * Login page — split-screen layout (brand panel + form), warm stone/amber
 * design language. Demo accounts are one-click quick-fill chips.
 *
 * NOT YET ROUTED — the integration agent mounts this at /login and guards
 * the app shell with <RequireAuth> (see docs/auth-integration.md).
 */
import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertCircle, Building2, CalendarCheck, Eye, EyeOff, Lock, ShieldCheck,
  User, Wallet,
} from 'lucide-react';
import { useAuth } from '@/lib/authContext';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';

interface DemoAccount {
  label: string;
  username: string;
  password: string;
  hint: string;
}

/** Mirrors the fixed/derived accounts seeded in src/lib/auth.ts. */
const DEMO_ACCOUNTS: DemoAccount[] = [
  { label: 'Admin', username: 'admin', password: 'admin123', hint: 'Full access' },
  { label: 'HR', username: 'hr', password: 'hr123', hint: 'Full access' },
  { label: 'Manager', username: 'ahmad.faizal', password: 'manager123', hint: 'Engineering dept only' },
  { label: 'Employee', username: 'siti5', password: 'password123', hint: 'Own records only' },
];

const HIGHLIGHTS = [
  { icon: Wallet, text: 'Payroll with EPF, SOCSO, EIS & PCB built in' },
  { icon: CalendarCheck, text: 'Attendance, leave and claims in one place' },
  { icon: ShieldCheck, text: 'Role-based views for Admin, HR, Managers & Employees' },
];

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from =
    (location.state as { from?: string } | null)?.from && location.state.from !== '/login'
      ? (location.state as { from: string }).from
      : '/';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const result = login(username, password);
    setSubmitting(false);
    if (result.ok) {
      navigate(from, { replace: true });
    } else {
      setError(result.error);
    }
  };

  const fill = (acc: DemoAccount) => {
    setUsername(acc.username);
    setPassword(acc.password);
    setError(null);
  };

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* Brand panel (desktop) */}
      <div className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-stone-900 p-12 text-stone-100 lg:flex">
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            background:
              'radial-gradient(600px circle at 20% 20%, rgba(245, 158, 11, 0.18), transparent 60%), radial-gradient(500px circle at 80% 90%, rgba(180, 83, 9, 0.15), transparent 60%)',
          }}
        />
        <div className="relative flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500 text-stone-900">
            <Building2 className="h-5 w-5" />
          </span>
          <div>
            <p className="text-lg font-semibold leading-tight">ASM Tech</p>
            <p className="text-xs text-stone-400">Malaysian HRMS & Payroll</p>
          </div>
        </div>

        <div className="relative space-y-8">
          <h1 className="max-w-md text-4xl font-semibold leading-tight tracking-tight">
            Run payroll your whole team can{' '}
            <span className="text-amber-400">trust</span>.
          </h1>
          <ul className="space-y-4">
            {HIGHLIGHTS.map((h) => (
              <li key={h.text} className="flex items-start gap-3 text-sm text-stone-300">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-stone-800 text-amber-400">
                  <h.icon className="h-4 w-4" />
                </span>
                {h.text}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-stone-500">
          Demo build — accounts are seeded locally, no data leaves your browser.
        </p>
      </div>

      {/* Form panel */}
      <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md space-y-6">
          {/* Mobile brand mark */}
          <div className="flex items-center gap-3 lg:hidden">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Building2 className="h-4 w-4" />
            </span>
            <div>
              <p className="font-semibold leading-tight">ASM Tech HRMS</p>
              <p className="text-xs text-muted-foreground">Malaysian HRMS & Payroll</p>
            </div>
          </div>

          <Card className="rounded-xl border shadow-sm">
            <CardHeader className="space-y-1">
              <CardTitle className="text-2xl">Welcome back</CardTitle>
              <CardDescription>Sign in to your workspace to continue.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="space-y-4" noValidate>
                {error && (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
                  >
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    {error}
                  </div>
                )}

                <div className="space-y-2">
                  <Label htmlFor="username">Username</Label>
                  <div className="relative">
                    <User className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="username"
                      autoComplete="username"
                      placeholder="e.g. admin"
                      className={cn('pl-9', error && 'border-red-300 focus-visible:ring-red-300')}
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      autoFocus
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      placeholder="••••••••"
                      className={cn('pl-9 pr-10', error && 'border-red-300 focus-visible:ring-red-300')}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((s) => !s)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-2 top-1.5 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>

                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? 'Signing in…' : 'Sign in'}
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Demo quick-fill */}
          <div className="space-y-2">
            <p className="text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Demo accounts — tap to fill
            </p>
            <div className="grid grid-cols-2 gap-2">
              {DEMO_ACCOUNTS.map((acc) => (
                <button
                  key={acc.username}
                  type="button"
                  onClick={() => fill(acc)}
                  className={cn(
                    'rounded-xl border bg-card px-3 py-2.5 text-left transition-colors',
                    'hover:border-amber-400/60 hover:bg-amber-50/60 dark:hover:bg-amber-950/20',
                    username === acc.username && 'border-amber-500/70 bg-amber-50/60 dark:bg-amber-950/20',
                  )}
                >
                  <span className="block text-sm font-medium">{acc.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {acc.username} · {acc.hint}
                  </span>
                </button>
              ))}
            </div>
            <p className="text-center text-xs text-muted-foreground">
              Every seeded employee can also sign in as{' '}
              <span className="font-medium text-foreground">email-prefix / password123</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
