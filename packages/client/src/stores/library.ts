import type React from 'react';
import { create } from 'zustand';
import type { Library, Show, Season, Episode, Movie } from '@plex-meta-editor/shared';
import { SectionType } from '@plex-meta-editor/shared';
import { api, type MarkerSummaryEntry } from '../api/client';

/** A group of episodes that share the same media file */
export interface EpisodeGroup {
  /** All episodes in this group, sorted by index */
  episodes: Episode[];
  /** The shared media file path (or unique key for singles) */
  groupKey: string;
  /** Whether this is a multi-episode group (2+ episodes) */
  isMulti: boolean;
  /** Total duration (sum of all episode durations) */
  totalDuration: number;
  /** Label like "E01" or "E01-E02" */
  label: string;
}

/** Group episodes by shared media file */
export function groupEpisodes(episodes: Episode[]): EpisodeGroup[] {
  const byFile = new Map<string, Episode[]>();
  for (const ep of episodes) {
    // Group by file path; if no media file, use unique key per episode
    const key = ep.mediaFilePath || `__single_${ep.id}`;
    const group = byFile.get(key) || [];
    group.push(ep);
    byFile.set(key, group);
  }

  const groups: EpisodeGroup[] = [];
  // Maintain original order: use the first episode's index as sort key
  const sorted = [...byFile.entries()].sort((a, b) => a[1][0].index - b[1][0].index);

  for (const [groupKey, eps] of sorted) {
    eps.sort((a, b) => a.index - b.index);
    const first = eps[0];
    const last = eps[eps.length - 1];
    const label = eps.length === 1
      ? `E${String(first.index).padStart(2, '0')}`
      : `E${String(first.index).padStart(2, '0')}-E${String(last.index).padStart(2, '0')}`;

    groups.push({
      episodes: eps,
      groupKey,
      isMulti: eps.length > 1,
      // Use actual file duration when available — metadata_items.duration can be
      // wrong for both multi-episode files and single files containing full combined content.
      // Markers are always file-relative, so the display duration must match the file.
      totalDuration: eps[0].fileDuration > 0
        ? eps[0].fileDuration
        : eps.reduce((sum, e) => sum + e.duration, 0),
      label,
    });
  }

  return groups;
}

interface LibraryState {
  // Data
  libraries: Library[];
  shows: Show[];
  seasons: Season[];
  episodes: Episode[];
  movies: Movie[];
  /** Marker summary: itemId → array of { type, start, end } entries */
  markerSummary: Record<number, MarkerSummaryEntry[]>;
  /** Chapter summary: itemId → array of chapter start positions in ms */
  chapterSummary: Record<number, number[]>;

  // Selection
  selectedLibrary: Library | null;
  selectedShow: Show | null;
  selectedSeason: Season | null;
  selectedEpisodeId: number | null;
  selectedMovieId: number | null;
  /** The currently selected multi-episode group (null for single episodes) */
  selectedEpisodeGroup: Episode[] | null;

  // Search
  searchQuery: string;
  searchExpanded: boolean;

  // Loading
  loading: boolean;
  error: string | null;

  // Actions
  loadLibraries: () => Promise<void>;
  selectLibrary: (lib: Library) => Promise<void>;
  selectAllLibraries: () => void;
  selectShow: (show: Show) => Promise<void>;
  selectSeason: (season: Season) => Promise<void>;
  selectEpisode: (id: number) => void;
  selectEpisodeGroup: (group: EpisodeGroup) => void;
  selectMovie: (id: number) => void;
  clearSelection: () => void;
  setSearchQuery: (query: string) => void;
  setSearchExpanded: (expanded: boolean) => void;
  resetSearch: () => void;
  refreshMarkerSummary: () => Promise<void>;
}

/** Convert string-keyed API response to number-keyed Record */
function parseSummary(raw: Record<string, MarkerSummaryEntry[]>): Record<number, MarkerSummaryEntry[]> {
  const result: Record<number, MarkerSummaryEntry[]> = {};
  for (const [id, entries] of Object.entries(raw)) {
    result[Number(id)] = entries;
  }
  return result;
}

function parseChapterSummary(raw: Record<string, number[]>): Record<number, number[]> {
  const result: Record<number, number[]> = {};
  for (const [id, entries] of Object.entries(raw)) {
    result[Number(id)] = entries;
  }
  return result;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  libraries: [],
  shows: [],
  seasons: [],
  episodes: [],
  movies: [],
  markerSummary: {},
  chapterSummary: {},
  selectedLibrary: null,
  selectedShow: null,
  selectedSeason: null,
  selectedEpisodeId: null,
  selectedMovieId: null,
  selectedEpisodeGroup: null,
  searchQuery: '',
  searchExpanded: false,
  loading: false,
  error: null,

  loadLibraries: async () => {
    set({ loading: true, error: null });
    try {
      const libraries = await api.getLibraries();
      set({ libraries, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load libraries', loading: false });
    }
  },

  selectLibrary: async (lib) => {
    set({
      selectedLibrary: lib,
      selectedShow: null,
      selectedSeason: null,
      selectedEpisodeId: null,
      selectedMovieId: null,
      selectedEpisodeGroup: null,
      shows: [],
      seasons: [],
      episodes: [],
      movies: [],
      markerSummary: {},
      chapterSummary: {},
      loading: true,
      error: null,
    });
    try {
      if (lib.type === SectionType.TV) {
        const shows = await api.getShows(lib.id);
        set({ shows, loading: false });
      } else {
        const [movies, summaryRaw, chapterRaw] = await Promise.all([
          api.getMovies(lib.id),
          api.getLibraryMarkerSummary(lib.id),
          api.getLibraryChapterSummary(lib.id),
        ]);
        set({ movies, markerSummary: parseSummary(summaryRaw), chapterSummary: parseChapterSummary(chapterRaw), loading: false });
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load items', loading: false });
    }
  },

  selectAllLibraries: () => {
    set({
      selectedLibrary: null,
      selectedShow: null,
      selectedSeason: null,
      selectedEpisodeId: null,
      selectedMovieId: null,
      selectedEpisodeGroup: null,
      shows: [],
      seasons: [],
      episodes: [],
      movies: [],
      markerSummary: {},
      chapterSummary: {},
      loading: false,
      error: null,
    });
  },

  selectShow: async (show) => {
    set({
      selectedShow: show,
      selectedSeason: null,
      selectedEpisodeId: null,
      selectedEpisodeGroup: null,
      seasons: [],
      episodes: [],
      loading: true,
      error: null,
    });
    try {
      const seasons = await api.getSeasons(show.id);
      set({ seasons, loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load seasons', loading: false });
    }
  },

  selectSeason: async (season) => {
    set({
      selectedSeason: season,
      selectedEpisodeId: null,
      selectedEpisodeGroup: null,
      episodes: [],
      markerSummary: {},
      loading: true,
      error: null,
    });
    try {
      const [episodes, summaryRaw, chapterRaw] = await Promise.all([
        api.getEpisodesBySeason(season.id),
        api.getSeasonMarkerSummary(season.id),
        api.getSeasonChapterSummary(season.id),
      ]);
      set({ episodes, markerSummary: parseSummary(summaryRaw), chapterSummary: parseChapterSummary(chapterRaw), loading: false });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load episodes', loading: false });
    }
  },

  selectEpisode: (id) => {
    set({ selectedEpisodeId: id, selectedMovieId: null, selectedEpisodeGroup: null });
  },

  selectEpisodeGroup: (group) => {
    set({
      selectedEpisodeId: group.episodes[0].id,
      selectedMovieId: null,
      selectedEpisodeGroup: group.isMulti ? group.episodes : null,
    });
  },

  selectMovie: (id) => {
    set({ selectedMovieId: id, selectedEpisodeId: null, selectedEpisodeGroup: null });
  },

  clearSelection: () => {
    set({
      selectedShow: null,
      selectedSeason: null,
      selectedEpisodeId: null,
      selectedMovieId: null,
      selectedEpisodeGroup: null,
      seasons: [],
      episodes: [],
      markerSummary: {},
    });
  },

  setSearchQuery: (query) => {
    set({ searchQuery: query });
  },

  setSearchExpanded: (expanded) => {
    set({ searchExpanded: expanded });
  },

  resetSearch: () => {
    set({ searchQuery: '', searchExpanded: false });
  },

  refreshMarkerSummary: async () => {
    const { selectedSeason, selectedLibrary } = get();
    try {
      if (selectedSeason) {
        const [summaryRaw, chapterRaw] = await Promise.all([
          api.getSeasonMarkerSummary(selectedSeason.id),
          api.getSeasonChapterSummary(selectedSeason.id),
        ]);
        set({ markerSummary: parseSummary(summaryRaw), chapterSummary: parseChapterSummary(chapterRaw) });
      } else if (selectedLibrary && selectedLibrary.type === SectionType.Movie) {
        const [summaryRaw, chapterRaw] = await Promise.all([
          api.getLibraryMarkerSummary(selectedLibrary.id),
          api.getLibraryChapterSummary(selectedLibrary.id),
        ]);
        set({ markerSummary: parseSummary(summaryRaw), chapterSummary: parseChapterSummary(chapterRaw) });
      }
    } catch {
      // Silent failure — marker/chapter summary is non-critical
    }
  },
}));

// ── Hash URL builders ────────────────────────────────────────────

export interface NavTarget {
  libraryId?: number;
  showId?: number;
  seasonId?: number;
  episodeId?: number;
  movieId?: number;
  search?: string;
}

/** Build a hash URL from navigation parameters. */
export function buildNavHash(target: NavTarget): string {
  const parts: string[] = [];
  if (target.search) {
    parts.push(`search=${encodeURIComponent(target.search)}`);
  } else {
    if (target.libraryId) parts.push(`lib=${target.libraryId}`);
    if (target.showId) parts.push(`show=${target.showId}`);
    if (target.seasonId) parts.push(`season=${target.seasonId}`);
    if (target.episodeId) parts.push(`ep=${target.episodeId}`);
    if (target.movieId) parts.push(`movie=${target.movieId}`);
  }
  return parts.length > 0 ? `#${parts.join('&')}` : '#';
}

/** Handle click on a nav link: prevent default for normal clicks (SPA navigation),
 *  allow ctrl/cmd+click and middle-click to open in new tab naturally. */
export function handleNavClick(e: React.MouseEvent, action: () => void): void {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
  e.preventDefault();
  action();
}

// ── URL hash sync ─────────────────────────────────────────────────

let _suppressHashSync = false;
let _isRestoringFromHistory = false;
let _syncPending = false;
let _lastPushedHash = window.location.hash;
let _lastSearchExpanded = false;

/** Write current selection to the URL hash, debounced via microtask. */
function syncToHash() {
  if (_suppressHashSync) return;
  if (_syncPending) return;
  _syncPending = true;
  queueMicrotask(() => {
    _syncPending = false;
    if (_suppressHashSync) return;
    const { selectedLibrary, selectedShow, selectedSeason, selectedEpisodeId, selectedMovieId, searchQuery, searchExpanded } = useLibraryStore.getState();
    const parts: string[] = [];
    if (searchExpanded && searchQuery) {
      parts.push(`search=${encodeURIComponent(searchQuery)}`);
    } else {
      if (selectedLibrary) parts.push(`lib=${selectedLibrary.id}`);
      if (selectedShow) parts.push(`show=${selectedShow.id}`);
      if (selectedSeason) parts.push(`season=${selectedSeason.id}`);
      if (selectedEpisodeId) parts.push(`ep=${selectedEpisodeId}`);
      if (selectedMovieId) parts.push(`movie=${selectedMovieId}`);
    }
    const hash = parts.length > 0 ? `#${parts.join('&')}` : '';
    if (window.location.hash === hash) {
      _lastSearchExpanded = searchExpanded;
      return;
    }

    // When typing in expanded search, just update the current entry (replaceState)
    // rather than creating a new history entry per keystroke. Push only when
    // searchExpanded toggles or on non-search navigations.
    const isSearchTyping = searchExpanded && _lastSearchExpanded;
    _lastSearchExpanded = searchExpanded;

    if (_isRestoringFromHistory || isSearchTyping) {
      window.history.replaceState(null, '', hash || window.location.pathname);
    } else {
      window.history.pushState(null, '', hash || window.location.pathname);
    }
    _lastPushedHash = hash;
  });
}

// Subscribe to store changes and update hash
useLibraryStore.subscribe(syncToHash);

// Listen for back/forward navigation
window.addEventListener('popstate', () => {
  const currentHash = window.location.hash;
  if (currentHash === _lastPushedHash) return;
  _lastPushedHash = currentHash;
  void restoreFromHash(true);
});

/** Restore selection from URL hash on app startup or popstate */
export async function restoreFromHash(isPopstate = false) {
  const hash = window.location.hash.slice(1);

  // Suppress hash syncing during restore so intermediate states
  // (selectLibrary setting selectedEpisodeId=null etc.) don't overwrite the hash
  _suppressHashSync = true;
  if (isPopstate) _isRestoringFromHistory = true;

  try {
    // Always load libraries
    if (!useLibraryStore.getState().libraries.length) {
      await useLibraryStore.getState().loadLibraries();
    }

    if (!hash) {
      // Back to home — clear selection and search
      if (isPopstate) {
        useLibraryStore.getState().selectAllLibraries();
        useLibraryStore.setState({ searchQuery: '', searchExpanded: false });
      }
      return;
    }

    const params = new URLSearchParams(hash);
    const searchParam = params.get('search');

    if (searchParam) {
      const query = decodeURIComponent(searchParam);
      useLibraryStore.setState({ searchQuery: query, searchExpanded: true });
      return;
    }

    // Clear search when restoring a non-search hash
    useLibraryStore.setState({ searchQuery: '', searchExpanded: false });

    const libId = Number(params.get('lib'));
    const showId = Number(params.get('show'));
    const seasonId = Number(params.get('season'));
    const epId = Number(params.get('ep'));
    const movieId = Number(params.get('movie'));

    if (!libId) return;

    const lib = useLibraryStore.getState().libraries.find(l => l.id === libId);
    if (!lib) return;
    await useLibraryStore.getState().selectLibrary(lib);

    if (movieId) {
      useLibraryStore.getState().selectMovie(movieId);
      return;
    }

    if (!showId) return;
    const show = useLibraryStore.getState().shows.find(s => s.id === showId);
    if (!show) return;
    await useLibraryStore.getState().selectShow(show);

    if (!seasonId) return;
    const season = useLibraryStore.getState().seasons.find(s => s.id === seasonId);
    if (!season) return;
    await useLibraryStore.getState().selectSeason(season);

    if (!epId) return;
    // Find the episode group containing this episode
    const episodes = useLibraryStore.getState().episodes;
    const groups = groupEpisodes(episodes);
    const group = groups.find(g => g.episodes.some(e => e.id === epId));
    if (group) {
      useLibraryStore.getState().selectEpisodeGroup(group);
    }
  } finally {
    _suppressHashSync = false;
    _isRestoringFromHistory = false;
    // Sync the final state to hash (replaceState for initial load, already at correct URL for popstate)
    _isRestoringFromHistory = true;
    syncToHash();
    // Reset after the queued microtask fires
    queueMicrotask(() => { _isRestoringFromHistory = false; });
  }
}
