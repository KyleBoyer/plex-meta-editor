import type { CSSProperties, ReactNode } from 'react';
import { SectionType, type Library } from '@plex-meta-editor/shared';
import { useLibraryStore, buildNavHash, handleNavClick } from '../../stores/library';

interface SidebarProps {
  style?: CSSProperties;
  collapsed?: boolean;
}

function HomeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M6 9.75V20h12V9.75" />
    </svg>
  );
}

function MovieIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M8 4.5v15M16 4.5v15M3 9.5h5M16 9.5h5M3 14.5h5M16 14.5h5" />
    </svg>
  );
}

function TvIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="5.5" width="18" height="12.5" rx="2.2" />
      <path d="M9 20h6" />
    </svg>
  );
}

function RailItem({
  active,
  label,
  icon,
  href,
  onClick,
  collapsed,
}: {
  active: boolean;
  label: string;
  icon: ReactNode;
  href: string;
  onClick: () => void;
  collapsed?: boolean;
}) {
  return (
    <a
      href={href}
      onClick={e => handleNavClick(e, onClick)}
      className={`plex-rail-item ${active ? 'plex-rail-item-active' : ''} ${collapsed ? 'plex-rail-item-collapsed' : ''}`}
      title={collapsed ? label : undefined}
    >
      <span className="plex-rail-icon shrink-0">{icon}</span>
      {!collapsed && (
        <div className="min-w-0 flex-1 text-left">
          <div className="plex-rail-label">{label}</div>
        </div>
      )}
    </a>
  );
}

export function Sidebar({ style, collapsed }: SidebarProps) {
  const { libraries, selectedLibrary, selectLibrary, selectAllLibraries } = useLibraryStore();
  const orderedLibraries = orderLibraries(libraries);

  return (
    <aside className={`plex-rail flex flex-col overflow-hidden shrink-0 ${collapsed ? 'plex-rail-collapsed' : ''}`} style={style}>
      <nav className="plex-rail-list" aria-label="Libraries">
        <div className="space-y-1">
          <RailItem
            active={!selectedLibrary}
            label="Home"
            icon={<HomeIcon />}
            href="#"
            onClick={() => selectAllLibraries()}
            collapsed={collapsed}
          />

          {orderedLibraries.map(library => (
            <RailItem
              key={library.id}
              active={selectedLibrary?.id === library.id}
              label={library.name}
              icon={library.type === SectionType.TV ? <TvIcon /> : <MovieIcon />}
              href={buildNavHash({ libraryId: library.id })}
              onClick={() => { void selectLibrary(library); }}
              collapsed={collapsed}
            />
          ))}
        </div>
      </nav>
    </aside>
  );
}

function orderLibraries(libraries: Library[]): Library[] {
  return [...libraries].sort((a, b) => {
    const kidRank = Number(isKidLibrary(a)) - Number(isKidLibrary(b));
    if (kidRank !== 0) return kidRank;

    const typeRank = libraryTypeRank(a) - libraryTypeRank(b);
    if (typeRank !== 0) return typeRank;

    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}

function isKidLibrary(library: Library): boolean {
  return /\bkids?\b|children|family/i.test(library.name);
}

function libraryTypeRank(library: Library): number {
  return library.type === SectionType.TV ? 1 : 0;
}
