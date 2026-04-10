import { useState } from 'react';
import {
  useViewPreferencesStore,
  GRID_SIZE_RANGES,
  AVAILABLE_COLUMNS,
  type SectionKey,
  type ViewMode,
} from '../../stores/viewPreferences';

function GridIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  );
}

function DetailIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function TableIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="4" height="4" />
      <line x1="10" y1="5" x2="21" y2="5" />
      <rect x="3" y="10" width="4" height="4" />
      <line x1="10" y1="12" x2="21" y2="12" />
      <rect x="3" y="17" width="4" height="4" />
      <line x1="10" y1="19" x2="21" y2="19" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ColumnsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3h7v18H3zM14 3h7v18h-7z" />
    </svg>
  );
}

const VIEW_OPTIONS: { mode: ViewMode; label: string; Icon: () => React.JSX.Element }[] = [
  { mode: 'grid', label: 'Grid View', Icon: GridIcon },
  { mode: 'detail', label: 'Detail View', Icon: DetailIcon },
  { mode: 'table', label: 'Table View', Icon: TableIcon },
];

interface Props {
  sectionKey: SectionKey;
}

export function ViewModeSelector({ sectionKey }: Props) {
  const viewMode = useViewPreferencesStore(s => s.viewModes[sectionKey]);
  const gridSize = useViewPreferencesStore(s => s.gridSizes[sectionKey]);
  const tableColumns = useViewPreferencesStore(s => s.tableColumns[sectionKey]);
  const setViewMode = useViewPreferencesStore(s => s.setViewMode);
  const setGridSize = useViewPreferencesStore(s => s.setGridSize);
  const toggleTableColumn = useViewPreferencesStore(s => s.toggleTableColumn);
  const [menuOpen, setMenuOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);

  const range = GRID_SIZE_RANGES[sectionKey];
  const gridPct = ((gridSize - range.min) / (range.max - range.min)) * 100;
  const ActiveIcon = VIEW_OPTIONS.find(o => o.mode === viewMode)?.Icon ?? GridIcon;
  const availableColumns = AVAILABLE_COLUMNS[sectionKey];

  return (
    <div className="flex items-center gap-2.5 shrink-0">
      {viewMode === 'grid' && (
        <input
          type="range"
          className="plex-grid-slider"
          min={range.min}
          max={range.max}
          step={range.step}
          value={gridSize}
          onChange={(e) => setGridSize(sectionKey, Number(e.target.value))}
          style={{ '--grid-pct': `${gridPct}%` } as React.CSSProperties}
          title={`Card size: ${gridSize}px`}
        />
      )}

      {viewMode === 'table' && (
        <div className="relative">
          <button
            onClick={() => { setColumnsOpen(!columnsOpen); setMenuOpen(false); }}
            className={`flex items-center justify-center gap-1.5 h-[30px] px-2 rounded transition-colors ${
              columnsOpen ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white/80 hover:bg-white/5'
            }`}
            title="Choose columns"
          >
            <ColumnsIcon />
            <svg width="8" height="5" viewBox="0 0 8 5" fill="none" className="opacity-60">
              <path d="M1 1l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {columnsOpen && (
            <>
              <div className="fixed inset-0 z-[99]" onClick={() => setColumnsOpen(false)} />
              <div className="absolute right-0 top-full mt-1 z-[100] plex-view-menu">
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-[var(--color-text-faint)] font-semibold">Columns</div>
                {availableColumns.map(col => {
                  const active = tableColumns.includes(col.key);
                  const isTitle = col.key === 'title';
                  return (
                    <button
                      key={col.key}
                      className={`plex-view-menu-item ${active ? 'plex-view-menu-item-active' : ''} ${isTitle ? 'opacity-50 cursor-default' : ''}`}
                      onClick={() => { if (!isTitle) toggleTableColumn(sectionKey, col.key); }}
                    >
                      <span>{col.label}</span>
                      {active && <CheckIcon />}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      <div className="relative">
        <button
          onClick={() => { setMenuOpen(!menuOpen); setColumnsOpen(false); }}
          className={`flex items-center justify-center gap-1.5 h-[30px] px-2 rounded transition-colors ${
            menuOpen ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white/80 hover:bg-white/5'
          }`}
          title="View options"
        >
          <ActiveIcon />
          <svg width="8" height="5" viewBox="0 0 8 5" fill="none" className="opacity-60">
            <path d="M1 1l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-[99]" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-full mt-1 z-[100] plex-view-menu">
              {VIEW_OPTIONS.map(({ mode, label, Icon }) => (
                <button
                  key={mode}
                  className={`plex-view-menu-item ${viewMode === mode ? 'plex-view-menu-item-active' : ''}`}
                  onClick={() => { setViewMode(sectionKey, mode); setMenuOpen(false); }}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon />
                    {label}
                  </span>
                  {viewMode === mode && <CheckIcon />}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
