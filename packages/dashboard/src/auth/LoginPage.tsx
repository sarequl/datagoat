import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { Logo } from '../components/Logo';
import { useSession } from './SessionContext';

interface FromState {
  from?: string;
}

function redirectTarget(state: unknown): string {
  const from = (state as FromState | null)?.from;
  if (typeof from === 'string' && from.startsWith('/')) {
    return from;
  }
  return '/';
}

export function LoginPage() {
  const { login, status } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    passwordRef.current?.focus();
  }, []);

  if (status === 'authenticated') {
    return <Navigate to={redirectTarget(location.state)} replace />;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(password);
      navigate(redirectTarget(location.state), { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Incorrect password.');
      } else {
        setError('Could not sign in. Try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <Logo />
        <h1>Sign in to DataGoat</h1>
        <p className="muted">Enter your admin password to continue.</p>
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          ref={passwordRef}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
