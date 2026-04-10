import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ViewMode = 'grid' | 'detail' | 'table';
export type SectionKey = 'shows' | 'movies' | 'seasons' | 'episodes';

const DEFAULT_VIEW_MODES: Record<SectionKey, ViewMode> = {
  shows: 'detail',
  movies: 'detail',
  seasons: 'detail',
  episodes: 'detail',
};

const DEFAULT_GRID_SIZES: Record<SectionKey, number> = {
  shows: 150,
  movies: 150,
  seasons: 150,
  episodes: 296,
};

const DEFAULT_TABLE_COLUMNS: Record<SectionKey, string[]> = {
  movies: ['title', 'year'],
  shows: ['title', 'year'],
  seasons: ['title', 'episodes'],
  episodes: ['title', 'duration'],
};

interface ViewPreferencesState {
  viewModes: Record<SectionKey, ViewMode>;
  gridSizes: Record<SectionKey, number>;
  tableColumns: Record<SectionKey, string[]>;

  setViewMode: (section: SectionKey, mode: ViewMode) => void;
  setGridSize: (section: SectionKey, size: number) => void;
  setTableColumns: (section: SectionKey, columns: string[]) => void;
  toggleTableColumn: (section: SectionKey, column: string) => void;
}

export const useViewPreferencesStore = create<ViewPreferencesState>()(
  persist(
    (set) => ({
      viewModes: { ...DEFAULT_VIEW_MODES },
      gridSizes: { ...DEFAULT_GRID_SIZES },
      tableColumns: { ...DEFAULT_TABLE_COLUMNS },

      setViewMode: (section, mode) =>
        set((state) => ({
          viewModes: { ...state.viewModes, [section]: mode },
        })),

      setGridSize: (section, size) =>
        set((state) => ({
          gridSizes: { ...state.gridSizes, [section]: size },
        })),

      setTableColumns: (section, columns) =>
        set((state) => ({
          tableColumns: { ...state.tableColumns, [section]: columns },
        })),

      toggleTableColumn: (section, column) =>
        set((state) => {
          const current = state.tableColumns[section];
          // Title is always shown, can't be toggled off
          if (column === 'title') return state;
          const next = current.includes(column)
            ? current.filter(c => c !== column)
            : [...current, column];
          return { tableColumns: { ...state.tableColumns, [section]: next } };
        }),
    }),
    {
      name: 'plex-meta-editor-view-prefs',
      version: 2,
      migrate: (persisted) => {
        const state = (persisted && typeof persisted === 'object') ? persisted as Record<string, unknown> : {};
        return {
          viewModes: (state.viewModes as Record<SectionKey, ViewMode>) ?? { ...DEFAULT_VIEW_MODES },
          gridSizes: (state.gridSizes as Record<SectionKey, number>) ?? { ...DEFAULT_GRID_SIZES },
          tableColumns: { ...DEFAULT_TABLE_COLUMNS },
        };
      },
    },
  ),
);

export const GRID_SIZE_RANGES: Record<SectionKey, { min: number; max: number; step: number }> = {
  shows: { min: 100, max: 280, step: 10 },
  movies: { min: 100, max: 280, step: 10 },
  seasons: { min: 100, max: 280, step: 10 },
  episodes: { min: 180, max: 450, step: 10 },
};

export interface ColumnDef {
  key: string;
  label: string;
  /** Return the display value for this column */
  value: (item: Record<string, unknown>) => string;
  align?: 'left' | 'right';
}

export const AVAILABLE_COLUMNS: Record<SectionKey, ColumnDef[]> = {
  movies: [
    { key: 'title', label: 'Title', value: (m) => String(m.title ?? '') },
    { key: 'year', label: 'Year', value: (m) => m.year ? String(m.year) : '', align: 'right' },
    { key: 'duration', label: 'Duration', value: (m) => formatDurationCompact(Number(m.fileDuration || m.duration || 0)), align: 'right' },
    { key: 'contentRating', label: 'Content Rating', value: (m) => String(m.contentRating ?? ''), align: 'right' },
    { key: 'rating', label: 'Rating', value: (m) => m.rating != null ? String(Number(m.rating).toFixed(1)) : '', align: 'right' },
    { key: 'edition', label: 'Edition', value: (m) => String(m.edition ?? '') },
  ],
  shows: [
    { key: 'title', label: 'Title', value: (s) => String(s.title ?? '') },
    { key: 'year', label: 'Year', value: (s) => s.year ? String(s.year) : '', align: 'right' },
    { key: 'seasons', label: 'Seasons', value: (s) => String(s.seasonCount ?? ''), align: 'right' },
    { key: 'episodes', label: 'Episodes', value: (s) => String(s.episodeCount ?? ''), align: 'right' },
    { key: 'contentRating', label: 'Content Rating', value: (s) => String(s.contentRating ?? ''), align: 'right' },
    { key: 'rating', label: 'Rating', value: (s) => s.rating != null ? String(Number(s.rating).toFixed(1)) : '', align: 'right' },
    { key: 'studio', label: 'Studio', value: (s) => String(s.studio ?? '') },
    { key: 'genres', label: 'Genres', value: (s) => String(s.genres ?? '').split('|').filter(Boolean).join(', ') },
  ],
  seasons: [
    { key: 'title', label: 'Title', value: (s) => String(s.title ?? '') },
    { key: 'episodes', label: 'Episodes', value: (s) => String(s.episodeCount ?? ''), align: 'right' },
  ],
  episodes: [
    { key: 'title', label: 'Title', value: (e) => String(e.title ?? '') },
    { key: 'duration', label: 'Duration', value: (e) => formatDurationCompact(Number(e.totalDuration || e.fileDuration || e.duration || 0)), align: 'right' },
    { key: 'label', label: 'Episode', value: (e) => String(e.label ?? '') },
  ],
};

function formatDurationCompact(ms: number): string {
  if (!ms || ms <= 0) return '';
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h > 0) return `${h}hr ${m}min`;
  return `${m}min`;
}
