import { useTheme } from '../hooks/useTheme';
import { MoonIcon, SunIcon } from './icons';

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isDark = theme === 'dark';
  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button
      type="button"
      className="icon-button"
      onClick={toggle}
      aria-pressed={isDark}
      aria-label={label}
      title={label}
    >
      {isDark ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
