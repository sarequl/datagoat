import { type KeyboardEvent, useRef } from 'react';

export const SOURCE_TABS = [
  { id: 'referrers', label: 'Referrers' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'pages', label: 'Pages' },
  { id: 'countries', label: 'Countries' },
  { id: 'devices', label: 'Devices' },
  { id: 'browsers', label: 'Browsers' },
] as const;

export type SourceTab = (typeof SOURCE_TABS)[number]['id'];

export function isSourceTab(value: string | null): value is SourceTab {
  return SOURCE_TABS.some((tab) => tab.id === value);
}

interface SourceTabsProps {
  active: SourceTab;
  onSelect: (tab: SourceTab) => void;
}

export function SourceTabs({ active, onSelect }: SourceTabsProps) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const currentIndex = SOURCE_TABS.findIndex((tab) => tab.id === active);
    let nextIndex: number | undefined;
    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % SOURCE_TABS.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + SOURCE_TABS.length) % SOURCE_TABS.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = SOURCE_TABS.length - 1;
    }
    if (nextIndex !== undefined) {
      event.preventDefault();
      const nextTab = SOURCE_TABS[nextIndex];
      onSelect(nextTab.id);
      tabRefs.current[nextIndex]?.focus();
    }
  }

  return (
    <div className="source-tabs" role="tablist" aria-label="Source dimension" onKeyDown={onKeyDown}>
      {SOURCE_TABS.map((tab, index) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`source-tab-${tab.id}`}
            aria-selected={isActive}
            aria-controls="source-panel"
            tabIndex={isActive ? 0 : -1}
            className={`source-tab${isActive ? ' source-tab--active' : ''}`}
            onClick={() => onSelect(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
