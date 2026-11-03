import { useNavigate } from 'react-router-dom';
import { useSession } from '../auth/SessionContext';

export function AccountMenu() {
  const { logout, scope } = useSession();
  const navigate = useNavigate();

  async function onLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <details className="account-menu">
      <summary>
        <span className="account-menu__avatar" aria-hidden="true">
          {(scope ?? 'o').slice(0, 1).toUpperCase()}
        </span>
        <span>Account</span>
      </summary>
      <div className="account-menu__panel">
        <p className="muted">Signed in as {scope ?? 'owner'}</p>
        <button type="button" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </details>
  );
}
