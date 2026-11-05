// Shown when the session has ended and the address already carries `next` (api.ts onSignedOut): the suite's sign-in page
// would normally be here, but the dev server serves the app at `/` too, so this card signs in itself and goes on to `next`.
import { CalendarDays } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { signIn } from '../api';
import { Button } from './ui/button';
import { Input, Label } from './ui/input';

/** Where to go after signing in: `next` when it is a path on this origin, else the calendar's home. */
export function afterSignIn(search: string, base = '/calendar/'): string {
  const next = new URLSearchParams(search).get('next') ?? '';
  return next.startsWith('/') && !next.startsWith('//') ? next : base;
}

export function SignedOut() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      window.location.assign(afterSignIn(window.location.search));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-panel p-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-hairline bg-white p-8 shadow-sm">
        <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-2xl bg-primary-tint text-primary">
          <CalendarDays className="size-8" strokeWidth={1.5} />
        </div>
        <h1 className="mb-2 text-center text-2xl font-semibold text-ink">Sign in to FreeFlow</h1>
        <p className="mb-6 text-center text-sm leading-relaxed text-muted">Your session has ended. Sign in again to see your calendar.</p>
        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor="signin-email">Email</Label>
            <Input id="signin-email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="signin-password">Password</Label>
            <Input id="signin-password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {error && <p className="text-sm text-danger" role="alert">{error}</p>}
          <Button type="submit" disabled={busy} className="mt-2 w-full">{busy ? 'Signing in…' : 'Sign in'}</Button>
        </div>
      </form>
    </div>
  );
}
