import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { LoginPage } from './auth/LoginPage';
import { RequireAuth } from './auth/RequireAuth';
import { SessionProvider } from './auth/SessionContext';
import { AppShell } from './components/AppShell';
import { DashboardPage } from './pages/DashboardPage';
import { FunnelsPage } from './pages/FunnelsPage';
import { GoalsPage } from './pages/GoalsPage';
import { LivePage } from './pages/LivePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { SettingsPage } from './pages/SettingsPage';

export function AppRouter() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route path="/" element={<DashboardPage />} />
            <Route path="/live" element={<LivePage />} />
            <Route path="/funnels" element={<FunnelsPage />} />
            <Route path="/goals" element={<GoalsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  );
}
