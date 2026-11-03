import { NavLink, Outlet } from 'react-router-dom';
import { AccountMenu } from './AccountMenu';
import { Logo } from './Logo';
import { ThemeToggle } from './ThemeToggle';
import { WebsiteSwitcher } from './WebsiteSwitcher';

const NAV_ITEMS = [
  { to: '/', label: 'Overview', end: true },
  { to: '/live', label: 'Live' },
  { to: '/funnels', label: 'Funnels' },
  { to: '/goals', label: 'Goals' },
  { to: '/settings', label: 'Settings' },
];

export function AppShell() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Logo />
        <nav aria-label="Primary">
          <ul className="nav-list">
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => `nav-link${isActive ? ' nav-link--active' : ''}`}
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="topbar__title">Dashboard</span>
          <div className="topbar__actions">
            <WebsiteSwitcher />
            <ThemeToggle />
            <AccountMenu />
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
