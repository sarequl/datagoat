import { useCallback, useEffect, useState } from 'react';
import { applyTheme, getInitialTheme, type Theme, toggleTheme } from '../theme';

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => toggleTheme(current));
  }, []);

  return { theme, toggle };
}
