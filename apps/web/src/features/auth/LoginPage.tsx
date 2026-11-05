import { useState, type FormEvent } from 'react';

import { Alert, Button, TextField } from '@flowkit-demo/ui';
import { errorMessage } from '../../lib/api';

export function LoginPage({ onSignIn }: { onSignIn(email: string, password: string): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      await onSignIn(String(values.get('email') ?? ''), String(values.get('password') ?? ''));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-intro" aria-labelledby="login-title">
        <div className="wordmark"><span>FK</span><strong>FlowKit</strong></div>
        <p className="eyebrow">Workflow workspace</p>
        <h1 id="login-title">Keep every decision connected to its request.</h1>
        <p>Sign in to create work, review assigned tasks, and follow the activity trail.</p>
      </section>
      <section className="auth-card" aria-label="Sign in">
        <p className="eyebrow">Secure access</p>
        <h2>Sign in</h2>
        <p className="supporting">Use the credentials provided by your organization.</p>
        {error ? <Alert tone="error" title="Sign-in failed">{error}</Alert> : null}
        <form onSubmit={submit} className="stack-form">
          <TextField label="Email" name="email" type="email" autoComplete="username" required />
          <TextField label="Password" name="password" type="password" autoComplete="current-password" required />
          <Button type="submit" variant="primary" busy={busy}>Sign in</Button>
        </form>
      </section>
    </main>
  );
}
