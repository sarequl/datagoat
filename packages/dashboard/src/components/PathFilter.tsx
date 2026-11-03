import { useEffect, useState } from 'react';

interface PathFilterProps {
  value: string;
  onApply: (value: string) => void;
}

export function PathFilter({ value, onApply }: PathFilterProps) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    const handle = setTimeout(() => {
      if (draft !== value) {
        onApply(draft);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [draft, value, onApply]);

  return (
    <label className="path-filter">
      <span className="visually-hidden">Filter by path</span>
      <input
        type="search"
        className="path-filter__input"
        placeholder="/blog"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    </label>
  );
}
