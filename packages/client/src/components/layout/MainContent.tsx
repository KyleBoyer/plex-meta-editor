import { useDeferredValue, useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo, type ReactNode } from 'react';
import {
  SectionType,
  type Library,
  type LibrarySearchResult,
  type Marker,
  type MediaInfo,
  type Episode,
  type Movie,
  type Season,
  type Show,
  type VideoSourceMode,
} from '@plex-meta-editor/shared';
import { useLibraryStore, groupEpisodes, handleNavClick, buildNavHash, type EpisodeGroup } from '../../stores/library';
import { useMarkerStore } from '../../stores/markers';
import { useChapterStore } from '../../stores/chapters';
import { useSettingsStore, type PlaybackModeOverride } from '../../stores/settings';
import { getPlaybackIdentity, usePlaybackStore, type PlaybackMedia } from '../../stores/playback';
import { useSystemStore } from '../../stores/system';
import {
  VideoPlayer,
  type PlaybackFailureContext,
  type PlaybackStateChange,
  type VideoPlayerHandle,
} from '../player/VideoPlayer';
import { type EpisodeBoundary } from '../player/PlayerTimeline';
import { MarkerTable } from '../markers/MarkerTable';
import { MarkerForm } from '../markers/MarkerForm';
import { ChapterTable } from '../chapters/ChapterTable';
import { ChapterForm } from '../chapters/ChapterForm';
import { ArtworkImage } from '../media/ArtworkImage';
import { ViewModeSelector } from '../common/ViewModeSelector';
import { MarkerBar } from '../common/MarkerBar';
import { useViewPreferencesStore, AVAILABLE_COLUMNS, type SectionKey } from '../../stores/viewPreferences';
import { api } from '../../api/client';
import { formatTimeFull, parseTime } from '../../utils/time';

interface MainContentProps {
  searchQuery?: string;
  searchExpanded?: boolean;
  onResetSearch?: () => void;
}

type SearchFilter = 'top' | 'movie' | 'show';

type HomeShelf = {
  library: Library;
  title: string;
  description: string;
  items: Show[] | Movie[];
};

const TRANSCODE_MODE_SEQUENCE: VideoSourceMode[] = [
  'plex-transcode-full',
  'plex-transcode-safe',
  'plex-transcode',
];

function formatDuration(ms: number): string {
  if (!ms) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Fallback for episodes/movies with no title — shows "Episode N" or "Untitled" */
function episodeTitle(ep: { title: string; index?: number; seasonIndex?: number }): string {
  if (ep.title && ep.title.trim()) return ep.title;
  if (ep.seasonIndex != null && ep.index != null) return `S${ep.seasonIndex} \u00B7 E${String(ep.index).padStart(2, '0')}`;
  if (ep.index != null) return `Episode ${ep.index}`;
  return 'Untitled';
}

function getEpisodeBoundaries(group: EpisodeGroup): number[] | undefined {
  if (!group.isMulti) return undefined;
  const boundaries: number[] = [];
  let offset = 0;
  for (let i = 0; i < group.episodes.length - 1; i++) {
    offset += group.episodes[i].duration;
    boundaries.push(offset);
  }
  return boundaries;
}

function orderLibraries(libraries: Library[]): Library[] {
  const preferred = new Map([
    ['TV Shows', 0],
    ['Movies', 1],
    ['Kid Movies', 2],
    ['Kid TV Shows', 3],
  ]);

  return [...libraries].sort((a, b) => {
    const rankA = preferred.get(a.name) ?? 99;
    const rankB = preferred.get(b.name) ?? 99;
    if (rankA !== rankB) return rankA - rankB;
    return a.name.localeCompare(b.name);
  });
}

function buildShelfTitle(library: Library): { title: string; description: string } {
  switch (library.name) {
    case 'TV Shows':
      return { title: 'Continue Editing', description: 'Pick up where you left off.' };
    case 'Movies':
      return { title: 'Recently Added Movies', description: 'Browse movies and open marker or chapter edits.' };
    case 'Kid Movies':
      return { title: 'Kid Movies', description: 'Family-safe movie library.' };
    case 'Kid TV Shows':
      return { title: 'Kid TV Shows', description: 'Family-safe TV library.' };
    default:
      return { title: library.name, description: library.type === SectionType.TV ? 'TV library' : 'Movie library' };
  }
}

function buildLibraryFromResult(result: LibrarySearchResult): Library {
  return {
    id: result.libraryId,
    name: result.libraryName,
    type: result.libraryType,
    uuid: '',
  };
}

function buildShowFromResult(result: Extract<LibrarySearchResult, { kind: 'show' }>): Show {
  return {
    id: result.id,
    title: result.title,
    sortTitle: result.sortTitle,
    originalTitle: result.originalTitle,
    seasonCount: result.seasonCount,
    episodeCount: result.episodeCount,
    libraryId: result.libraryId,
    year: 0,
    summary: '',
    contentRating: '',
    rating: null,
    genres: '',
    studio: '',
  };
}

function isInternalTranscodeMode(mode: VideoSourceMode): boolean {
  return TRANSCODE_MODE_SEQUENCE.includes(mode);
}

function createTranscodeSessionId(metadataId: number): string {
  const uuid = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  return `pme-${metadataId}-${uuid}`;
}

function createPlaybackOwnerId(prefix: string): string {
  const uuid = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  return `${prefix}-${uuid}`;
}

function getModeSequence(
  playbackMode: PlaybackModeOverride,
  mediaInfo: (MediaInfo & { fileExists: boolean }) | null,
  plexConfigured: boolean,
  isSafari: boolean,
): VideoSourceMode[] {
  if (playbackMode === 'direct') return ['direct'];
  if (playbackMode === 'plex-api') return plexConfigured ? ['plex-api'] : [];
  if (playbackMode === 'plex-transcode') return plexConfigured ? [...TRANSCODE_MODE_SEQUENCE] : [];

  const modes: VideoSourceMode[] = [];
  if (mediaInfo?.fileExists && !(isSafari && mediaInfo?.container === 'mkv')) {
    modes.push('direct');
  }
  if (plexConfigured) {
    modes.push('plex-api', ...TRANSCODE_MODE_SEQUENCE);
  }
  return modes;
}

function getStoredPlaybackResume(
  playbackMedia: PlaybackMedia | null,
  selectedEpisodeId: number | null,
  selectedMovieId: number | null,
  isActive: boolean,
  currentTime: number,
  isPlaying: boolean,
  volume: number,
  muted: boolean,
  playbackRate: number,
): { autoPlay: boolean; seekMs: number; volume: number; muted: boolean; playbackRate: number } | null {
  const matchesMovie = Boolean(selectedMovieId && playbackMedia?.target.movieId === selectedMovieId);
  const matchesEpisode = Boolean(selectedEpisodeId && playbackMedia?.target.episodeId === selectedEpisodeId);

  if (!matchesMovie && !matchesEpisode) {
    return null;
  }

  if (!isActive && currentTime <= 0 && !isPlaying) {
    return null;
  }

  return {
    autoPlay: isPlaying,
    seekMs: Math.max(0, currentTime),
    volume,
    muted,
    playbackRate,
  };
}

function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

function DatabaseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <ellipse cx="12" cy="5" rx="7" ry="3" />
      <path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5" />
      <path d="M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" />
    </svg>
  );
}

function MarkerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 4h8l4 4v12l-4-2-4 2-4-2-4 2V6a2 2 0 0 1 2-2z" />
      <path d="M10 4v6h8" />
    </svg>
  );
}

function BrowseHeader({
  title,
  description,
  eyebrow,
  action,
  backAction,
}: {
  title: string;
  description: string;
  eyebrow: string;
  action?: ReactNode;
  backAction?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="space-y-2">
        {backAction && (
          <button onClick={backAction.onClick} className="ctrl-btn mb-1">
            <ChevronLeftIcon />
            {backAction.label}
          </button>
        )}
        <div className="plex-kicker">{eyebrow}</div>
        {title && <h1 className="plex-display-title">{title}</h1>}
        {description && (
          <p className="plex-section-copy max-w-2xl text-sm md:text-base leading-7">
            {description}
          </p>
        )}
      </div>

      <div className="flex items-center gap-3 text-sm">
        {action}
      </div>
    </div>
  );
}

function ShelfSection({
  title,
  description,
  headerRight,
  children,
}: {
  title: string;
  description?: string;
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="plex-section-title">{title}</h2>
          {description && <p className="text-sm text-[var(--color-text-muted)]">{description}</p>}
        </div>
        {headerRight}
      </div>
      {children}
    </section>
  );
}

function PosterTile({
  title,
  meta,
  secondary,
  badge,
  artworkId,
  artworkIds,
  href,
  onClick,
  wide = false,
  markerItemId,
  markerDuration,
  episodeBoundaries,
}: {
  title: string;
  meta: string;
  secondary?: string;
  badge?: string;
  artworkId?: number | null;
  artworkIds?: Array<number | null | undefined>;
  href?: string;
  onClick: () => void;
  wide?: boolean;
  markerItemId?: number;
  markerDuration?: number;
  episodeBoundaries?: number[];
}) {
  return (
    <a href={href || '#'} onClick={e => handleNavClick(e, onClick)} className={`plex-poster-card ${wide ? 'plex-poster-card-wide' : ''}`}>
      <div className="plex-poster-frame border border-white/8">
        <ArtworkImage
          metadataId={artworkId}
          metadataIds={artworkIds}
          alt={title}
          className="plex-poster-image"
          loading="lazy"
          fallback={<div className="plex-artwork-fallback" />}
        />
        {badge && <span className="plex-poster-chip">{badge}</span>}
        {markerItemId != null && markerDuration != null && (
          <MarkerBar itemId={markerItemId} duration={markerDuration} className="plex-marker-line" episodeBoundaries={episodeBoundaries} />
        )}
      </div>
      <div className="plex-poster-body">
        <div className="plex-poster-title">{title}</div>
        <div className="plex-poster-meta">{meta}</div>
        {secondary && <div className="plex-poster-meta-secondary mt-1">{secondary}</div>}
      </div>
    </a>
  );
}

function DynamicTable<T extends object>({
  sectionKey,
  items,
  getKey,
  getHref,
  onClick,
}: {
  sectionKey: SectionKey;
  items: T[];
  getKey: (item: T) => string | number;
  getHref?: (item: T) => string;
  onClick: (item: T) => void;
}) {
  const tableColumns = useViewPreferencesStore(s => s.tableColumns[sectionKey]);
  const allColumns = AVAILABLE_COLUMNS[sectionKey];
  const visibleColumns = allColumns.filter(c => tableColumns.includes(c.key));
  const extraCols = visibleColumns.filter(c => c.key !== 'title');
  const gridCols = `minmax(0, 1fr)${extraCols.map(() => ' minmax(60px, auto)').join('')}`;

  const [sortCol, setSortCol] = useState<string>('title');
  const [sortAsc, setSortAsc] = useState(true);

  const handleSort = (key: string) => {
    if (sortCol === key) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(key);
      setSortAsc(true);
    }
  };

  const sorted = useMemo(() => {
    const col = allColumns.find(c => c.key === sortCol);
    if (!col) return items;
    return [...items].sort((a, b) => {
      const ra = a as unknown as Record<string, unknown>;
      const rb = b as unknown as Record<string, unknown>;
      const va = col.value(ra);
      const vb = col.value(rb);
      const na = Number(va);
      const nb = Number(vb);
      let cmp: number;
      if (!isNaN(na) && !isNaN(nb) && va !== '' && vb !== '') {
        cmp = na - nb;
      } else {
        cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' });
      }
      return sortAsc ? cmp : -cmp;
    });
  }, [items, sortCol, sortAsc, allColumns]);

  const SortArrow = ({ col }: { col: string }) => {
    if (sortCol !== col) return null;
    return (
      <svg width="8" height="5" viewBox="0 0 8 5" fill="none" className="inline-block ml-1" style={sortAsc ? undefined : { transform: 'rotate(180deg)' }}>
        <path d="M1 1l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  };

  return (
    <div className="plex-table-grid" style={{ gridTemplateColumns: gridCols }}>
      <button className="plex-table-grid-header plex-table-grid-header-sortable" onClick={() => handleSort('title')}>
        Title<SortArrow col="title" />
      </button>
      {extraCols.map(col => (
        <button
          key={`h-${col.key}`}
          className="plex-table-grid-header plex-table-grid-header-sortable"
          style={col.align === 'right' ? { textAlign: 'right' } : undefined}
          onClick={() => handleSort(col.key)}
        >
          {col.label}<SortArrow col={col.key} />
        </button>
      ))}

      {sorted.map(item => {
        const record = item as unknown as Record<string, unknown>;
        const markerId = Number(record.id || record.markerItemId || 0);
        const markerDur = Number(record.fileDuration || record.totalDuration || record.duration || 0);
        return (
          <a
            key={getKey(item)}
            href={getHref?.(item) || '#'}
            onClick={e => handleNavClick(e, () => onClick(item))}
            className="plex-table-grid-row"
            style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'subgrid' }}
          >
            {markerId > 0 && markerDur > 0 && (
              <MarkerBar itemId={markerId} duration={markerDur} className="plex-marker-bg" segmentOpacity={0.15} episodeBoundaries={record.episodeBoundaries as number[] | undefined} />
            )}
            <div className="text-sm font-medium text-white truncate relative z-[1]">{String(record.title ?? '')}</div>
            {extraCols.map(col => (
              <div key={col.key} className="text-sm text-[var(--color-text-muted)] whitespace-nowrap relative z-[1]" style={col.align === 'right' ? { textAlign: 'right' } : undefined}>
                {col.value(record)}
              </div>
            ))}
          </a>
        );
      })}
    </div>
  );
}

function DetailRow({
  title,
  meta,
  secondary,
  artworkId,
  artworkIds,
  href,
  onClick,
  wide = false,
  markerItemId,
  markerDuration,
  episodeBoundaries,
}: {
  title: string;
  meta: string;
  secondary?: string;
  artworkId?: number | null;
  artworkIds?: Array<number | null | undefined>;
  href?: string;
  onClick: () => void;
  wide?: boolean;
  markerItemId?: number;
  markerDuration?: number;
  episodeBoundaries?: number[];
}) {
  return (
    <a href={href || '#'} onClick={e => handleNavClick(e, onClick)} className={`plex-detail-row ${wide ? 'plex-detail-row-wide' : ''}`}>
      {markerItemId != null && markerDuration != null && markerDuration > 0 && (
        <MarkerBar itemId={markerItemId} duration={markerDuration} className="plex-marker-bg" segmentOpacity={0.15} episodeBoundaries={episodeBoundaries} />
      )}
      <div className="plex-detail-thumb">
        <ArtworkImage
          metadataId={artworkId}
          metadataIds={artworkIds}
          alt={title}
          className="w-full h-full object-cover"
          loading="lazy"
          fallback={<div className="plex-artwork-fallback w-full h-full" />}
        />
      </div>
      <div className="min-w-0 py-0.5 relative z-[1]">
        <div className="text-sm font-semibold text-white">{title}</div>
        <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{meta}</div>
        {secondary && <div className="text-xs text-[var(--color-text-faint)] mt-1.5 leading-relaxed line-clamp-2">{secondary}</div>}
      </div>
    </a>
  );
}

function SearchActionIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="m10 8 6 4-6 4V8Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SearchResultRow({
  result,
  href,
  onOpen,
}: {
  result: LibrarySearchResult;
  href?: string;
  onOpen: () => void;
}) {
  const meta = result.kind === 'show'
    ? 'Show'
    : result.year
      ? `${result.year} • Movie`
      : 'Movie';

  const detail = result.kind === 'show'
    ? `${result.seasonCount} seasons • ${result.episodeCount} episodes`
    : result.edition || formatDuration(result.fileDuration || result.duration);

  return (
    <a href={href || '#'} onClick={e => handleNavClick(e, onOpen)} className="plex-search-row">
      <div className="plex-search-thumb">
        <ArtworkImage
          metadataId={result.id}
          alt={result.title}
          className="plex-search-thumb-image"
          loading="lazy"
          fallback={<div className="plex-artwork-fallback" />}
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="plex-search-row-title">{result.title}</div>
        <div className="plex-search-row-meta">{meta}</div>
        <div className="plex-search-row-library">{result.libraryName}</div>
        <div className="plex-search-row-detail">{detail}</div>
      </div>

      <span className="plex-search-row-action" aria-hidden="true">
        <SearchActionIcon />
      </span>
    </a>
  );
}

function ShowDetail({ show }: { show: Show }) {
  const [synopsisExpanded, setSynopsisExpanded] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const [clamped, setClamped] = useState(false);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (el) setClamped(el.scrollHeight > el.clientHeight + 2);
  }, [show.summary]);

  const genres = show.genres ? show.genres.split('|').filter(Boolean) : [];

  return (
    <div className="flex gap-7 items-start">
      {/* Poster */}
      <div className="shrink-0 w-[200px] rounded-[4px] overflow-hidden hidden sm:block">
        <div className="aspect-[2/3] bg-white/5 relative">
          <ArtworkImage
            metadataId={show.id}
            kind="thumb"
            className="w-full h-full object-cover"
          />
          {show.seasonCount > 0 && (
            <span className="absolute top-2 right-2 bg-black/70 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
              {show.seasonCount}
            </span>
          )}
        </div>
      </div>

      {/* Metadata */}
      <div className="flex-1 min-w-0 space-y-2">
        <h2 className="text-[clamp(1.5rem,1.1rem+1vw,2rem)] font-bold text-white leading-tight">{show.title}</h2>

        {show.year > 0 && (
          <div className="text-[0.9375rem] text-[var(--color-text-muted)]">{show.year}</div>
        )}

        {genres.length > 0 && (
          <div className="text-[0.9375rem] text-[var(--color-text-muted)]">
            {genres.join(', ')}{genres.length > 2 ? ', and more' : ''}
          </div>
        )}

        {(show.contentRating || (show.rating != null && show.rating > 0)) && (
          <div className="flex items-center gap-3 flex-wrap">
            {show.contentRating && (
              <span className="px-1.5 py-0.5 border border-white/25 rounded text-xs font-semibold text-[var(--color-text-default)] leading-none">
                {show.contentRating}
              </span>
            )}
            {show.rating != null && show.rating > 0 && (
              <span className="text-sm text-[var(--color-text-muted)]">
                {Math.round(show.rating * 10)}%
              </span>
            )}
          </div>
        )}

        {/* Season info */}
        <div className="text-sm text-[var(--color-text-muted)] pt-1">
          {show.seasonCount} season{show.seasonCount === 1 ? '' : 's'} · {show.episodeCount} episode{show.episodeCount === 1 ? '' : 's'}
        </div>

        {show.summary && (
          <div className="space-y-1 max-w-lg pt-2">
            <p
              ref={textRef}
              className={`text-[0.9375rem] leading-relaxed text-[var(--color-text-default)] ${synopsisExpanded ? '' : 'line-clamp-3'}`}
            >
              {show.summary}
            </p>
            {clamped && !synopsisExpanded && (
              <button
                onClick={() => setSynopsisExpanded(true)}
                className="text-sm font-semibold text-[var(--color-accent)] hover:underline inline-flex items-center gap-1 cursor-pointer"
              >
                More
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
              </button>
            )}
          </div>
        )}

        {show.studio && (
          <div className="text-xs text-[var(--color-text-faint)] pt-1">{show.studio}</div>
        )}
      </div>
    </div>
  );
}

function SeasonDetail({ season, show }: { season: Season; show: Show | null }) {
  return (
    <div className="flex gap-7 items-start">
      <div className="shrink-0 w-[200px] rounded-[4px] overflow-hidden hidden sm:block">
        <div className="aspect-[2/3] bg-white/5 relative">
          <ArtworkImage
            metadataIds={[season.id, show?.id ?? season.showId]}
            kind="thumb"
            className="w-full h-full object-cover"
          />
          {season.episodeCount > 0 && (
            <span className="absolute top-2 right-2 bg-black/70 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
              {season.episodeCount}
            </span>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0 space-y-2">
        <h2 className="text-[clamp(1.5rem,1.1rem+1vw,2rem)] font-bold text-white leading-tight">
          {show?.title ?? season.showTitle}
        </h2>
        <div className="text-[0.9375rem] text-[var(--color-text-muted)]">
          {season.title}
        </div>
        <div className="text-sm text-[var(--color-text-muted)] pt-1">
          {season.episodeCount} episode{season.episodeCount === 1 ? '' : 's'}
        </div>
        {show && show.contentRating && (
          <div className="flex items-center gap-3 flex-wrap pt-1">
            <span className="px-1.5 py-0.5 border border-white/25 rounded text-xs font-semibold text-[var(--color-text-default)] leading-none">
              {show.contentRating}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

export function MainContent({ searchQuery, searchExpanded = false, onResetSearch }: MainContentProps) {
  const {
    libraries,
    shows,
    seasons,
    episodes,
    movies,
    selectedLibrary,
    selectedShow,
    selectedSeason,
    selectedEpisodeId,
    selectedMovieId,
    selectedEpisodeGroup,
    selectLibrary,
    selectShow,
    selectSeason,
    selectEpisodeGroup,
    selectMovie,
    clearSelection,
  } = useLibraryStore();

  const deferredSearch = useDeferredValue((searchQuery ?? '').trim());
  const isSearchView = Boolean(searchExpanded && deferredSearch);
  const selectedId = selectedEpisodeId || selectedMovieId;

  const orderedLibraries = useMemo(() => orderLibraries(libraries), [libraries]);
  const browseEpisodeGroups = useMemo(() => groupEpisodes(episodes), [episodes]);

  const filteredShows = shows;
  const filteredMovies = movies;
  const filteredSeasons = seasons;
  const filteredEpisodeGroups = browseEpisodeGroups;
  const viewModes = useViewPreferencesStore(s => s.viewModes);
  const gridSizes = useViewPreferencesStore(s => s.gridSizes);

  const isHomeView = !selectedLibrary && !selectedShow && !selectedSeason && !selectedId;

  const [homeShelves, setHomeShelves] = useState<HomeShelf[]>([]);
  const [homeShelvesLoading, setHomeShelvesLoading] = useState(false);
  const [homeShelvesError, setHomeShelvesError] = useState<string | null>(null);
  const [searchResults, setSearchResults] = useState<LibrarySearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchFilter, setSearchFilter] = useState<SearchFilter>('top');
  const [showAllSearchResults, setShowAllSearchResults] = useState(false);

  useEffect(() => {
    if (!orderedLibraries.length || !isHomeView) return;

    let cancelled = false;
    setHomeShelvesLoading(true);
    setHomeShelvesError(null);

    void Promise.all(
      orderedLibraries.map(async library => {
        const details = buildShelfTitle(library);
        if (library.type === SectionType.TV) {
          const items = await api.getShows(library.id);
          return { library, title: details.title, description: details.description, items: items.slice(0, 12) as Show[] };
        }

        const [items, summaryRaw, chapterRaw] = await Promise.all([
          api.getMovies(library.id),
          api.getLibraryMarkerSummary(library.id),
          api.getLibraryChapterSummary(library.id),
        ]);
        return { library, title: details.title, description: details.description, items: items.slice(0, 12) as Movie[], summaryRaw, chapterRaw };
      }),
    )
      .then(rows => {
        if (!cancelled) {
          setHomeShelves(rows.filter(row => row.items.length > 0));

          // Merge marker/chapter summaries from movie libraries into the store
          const mergedMarkers: Record<number, { type: string; start: number; end: number }[]> = {};
          const mergedChapters: Record<number, number[]> = {};
          for (const row of rows) {
            if ('summaryRaw' in row && row.summaryRaw) {
              for (const [id, entries] of Object.entries(row.summaryRaw)) {
                mergedMarkers[Number(id)] = entries;
              }
            }
            if ('chapterRaw' in row && row.chapterRaw) {
              for (const [id, entries] of Object.entries(row.chapterRaw)) {
                mergedChapters[Number(id)] = entries;
              }
            }
          }
          useLibraryStore.setState(prev => ({
            markerSummary: { ...prev.markerSummary, ...mergedMarkers },
            chapterSummary: { ...prev.chapterSummary, ...mergedChapters },
          }));
        }
      })
      .catch(err => {
        if (!cancelled) {
          setHomeShelves([]);
          setHomeShelvesError(err instanceof Error ? err.message : 'Failed to load home shelves');
        }
      })
      .finally(() => {
        if (!cancelled) setHomeShelvesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isHomeView, orderedLibraries]);

  useEffect(() => {
    if (!deferredSearch || !searchExpanded) {
      setSearchResults([]);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }

    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setSearchLoading(true);
      setSearchError(null);

      api.searchLibraries(deferredSearch)
        .then(results => {
          if (!cancelled) setSearchResults(results);
        })
        .catch(err => {
          if (!cancelled) {
            setSearchResults([]);
            setSearchError(err instanceof Error ? err.message : 'Failed to search');
          }
        })
        .finally(() => {
          if (!cancelled) setSearchLoading(false);
        });
    }, 160);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [deferredSearch, searchExpanded]);

  useEffect(() => {
    setSearchFilter('top');
    setShowAllSearchResults(Boolean(searchExpanded));
  }, [deferredSearch, searchExpanded]);

  const openHomeItem = useCallback(async (library: Library, item: Show | Movie) => {
    if (selectedLibrary?.id !== library.id) {
      await selectLibrary(library);
    }

    onResetSearch?.();

    if (library.type === SectionType.TV) {
      await selectShow(item as Show);
      return;
    }

    selectMovie((item as Movie).id);
  }, [onResetSearch, selectLibrary, selectMovie, selectShow, selectedLibrary?.id]);

  const openSearchResult = useCallback(async (result: LibrarySearchResult) => {
    const library = orderedLibraries.find(entry => entry.id === result.libraryId) ?? buildLibraryFromResult(result);
    if (selectedLibrary?.id !== library.id) {
      await selectLibrary(library);
    }

    onResetSearch?.();

    if (result.kind === 'show') {
      await selectShow(buildShowFromResult(result));
      return;
    }

    selectMovie(result.id);
  }, [onResetSearch, orderedLibraries, selectLibrary, selectMovie, selectShow, selectedLibrary?.id]);

  const movieSearchResults = useMemo(
    () => searchResults.filter((result): result is Extract<LibrarySearchResult, { kind: 'movie' }> => result.kind === 'movie'),
    [searchResults],
  );
  const showSearchResults = useMemo(
    () => searchResults.filter((result): result is Extract<LibrarySearchResult, { kind: 'show' }> => result.kind === 'show'),
    [searchResults],
  );

  const searchTabs = useMemo(() => {
    const tabs: Array<{ id: SearchFilter; label: string; count: number }> = [
      { id: 'top', label: 'Top Results', count: searchResults.length },
      { id: 'movie', label: 'Movies', count: movieSearchResults.length },
      { id: 'show', label: 'Shows', count: showSearchResults.length },
    ];

    return tabs.filter(tab => tab.id === 'top' || tab.count > 0);
  }, [movieSearchResults.length, searchResults.length, showSearchResults.length]);

  const activeSearchResults = searchFilter === 'movie'
    ? movieSearchResults
    : searchFilter === 'show'
      ? showSearchResults
      : searchResults;

  const visibleSearchResults = showAllSearchResults
    ? activeSearchResults
    : activeSearchResults.slice(0, 8);

  const hasMoreSearchResults = activeSearchResults.length > visibleSearchResults.length;

  const searchHeading = searchFilter === 'movie'
    ? `Movies for "${deferredSearch}"`
    : searchFilter === 'show'
      ? `Shows for "${deferredSearch}"`
      : `Top Results for "${deferredSearch}"`;

  if (isSearchView) {
    return (
      <div className="flex-1 min-w-0 overflow-y-auto">
        <div className="px-5 md:px-8 xl:px-10 py-6 md:py-8">
          <section className="plex-search-page animate-fade-in">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-3">
                <div className="plex-kicker">Search</div>
                <h1 className="plex-search-heading">{searchHeading}</h1>
                <p className="text-sm text-[var(--color-text-muted)]">
                  {searchLoading
                    ? 'Searching across your Plex libraries…'
                    : searchError
                      ? searchError
                      : `${activeSearchResults.length} result${activeSearchResults.length === 1 ? '' : 's'} ready.`}
                </p>
              </div>

            </div>

            <div className="plex-search-tabs">
              {searchTabs.map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setSearchFilter(tab.id);
                    setShowAllSearchResults(true);
                  }}
                  className={`plex-search-tab ${searchFilter === tab.id ? 'plex-search-tab-active' : ''}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="plex-search-results">
              {searchLoading && activeSearchResults.length === 0 ? (
                <div className="plex-search-empty text-sm text-[var(--color-text-muted)]">
                  Searching Plex libraries…
                </div>
              ) : searchError ? (
                <div className="plex-search-empty text-sm text-red-300/85">
                  {searchError}
                </div>
              ) : !searchLoading && !searchError && activeSearchResults.length === 0 ? (
                <div className="plex-search-empty text-sm text-[var(--color-text-muted)]">
                  No titles matched "{deferredSearch}". Try a broader search.
                </div>
              ) : (
                <>
                  <div className="plex-search-list">
                    {visibleSearchResults.map(result => (
                      <SearchResultRow
                        key={`${result.kind}-${result.id}`}
                        result={result}
                        href={buildNavHash(result.kind === 'show'
                          ? { libraryId: result.libraryId, showId: result.id }
                          : { libraryId: result.libraryId, movieId: result.id })}
                        onOpen={() => { void openSearchResult(result); }}
                      />
                    ))}
                  </div>

                  {hasMoreSearchResults && (
                    <div className="plex-search-footer">
                      <button
                        type="button"
                        onClick={() => setShowAllSearchResults(true)}
                        className="plex-search-more-button"
                      >
                        View More Results
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>
        </div>
      </div>
    );
  }

  if (selectedId) {
    return <EditorWorkspace />;
  }

  const browseHeader = isHomeView
    ? {
        eyebrow: 'Home',
        title: 'Home',
        description: 'A Plex-born marker workspace for browsing libraries and jumping straight into edits.',
      }
    : selectedSeason
      ? {
          eyebrow: '',
          title: '',
          description: '',
        }
      : selectedShow
        ? {
            eyebrow: '',
            title: '',
            description: '',
          }
        : selectedLibrary
          ? {
              eyebrow: 'Library',
              title: selectedLibrary.name,
              description: selectedLibrary.type === SectionType.TV
                ? `${filteredShows.length || shows.length} show${(filteredShows.length || shows.length) === 1 ? '' : 's'} available.`
                : `${filteredMovies.length || movies.length} movie${(filteredMovies.length || movies.length) === 1 ? '' : 's'} available.`,
            }
          : {
              eyebrow: 'Browse',
              title: 'Home',
              description: 'Open a library to start editing.',
            };

  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <div className="px-5 md:px-8 xl:px-10 py-6 md:py-8 space-y-7 md:space-y-8">
        <BrowseHeader
          eyebrow={browseHeader.eyebrow}
          title={browseHeader.title}
          description={browseHeader.description}
          backAction={(selectedSeason && selectedShow) ? {
            label: 'Seasons',
            onClick: () => { void selectShow(selectedShow); onResetSearch?.(); },
          } : selectedShow ? {
            label: selectedLibrary?.name || 'Library',
            onClick: () => { clearSelection(); onResetSearch?.(); },
          } : undefined}
        />

        {isHomeView && (
          <>
            {homeShelvesLoading && (
              <div className="plex-stage-panel p-5 text-sm text-[var(--color-text-muted)]">
                Loading Plex shelves…
              </div>
            )}

            {homeShelvesError && (
              <div className="plex-stage-panel p-5 text-sm text-red-300/85">
                {homeShelvesError}
              </div>
            )}

            {!homeShelvesLoading && !homeShelvesError && homeShelves.map(row => (
              <ShelfSection key={row.library.id} title={row.title} description={row.description}>
                <div className="plex-scroll-row">
                  {row.items.map(item => {
                    const isTv = row.library.type === SectionType.TV;
                    const title = item.title;
                    const meta = isTv
                      ? `${(item as Show).seasonCount} seasons • ${(item as Show).episodeCount} episodes`
                      : `${(item as Movie).year || 'Movie'} • ${formatDuration((item as Movie).fileDuration || (item as Movie).duration)}`;
                    const secondary = row.library.name;

                    return (
                      <PosterTile
                        key={item.id}
                        title={title}
                        meta={meta}
                        secondary={secondary}
                        badge={isTv ? 'Series' : 'Movie'}
                        artworkId={item.id}
                        href={buildNavHash(isTv
                          ? { libraryId: row.library.id, showId: item.id }
                          : { libraryId: row.library.id, movieId: item.id })}
                        onClick={() => { void openHomeItem(row.library, item); }}
                        markerItemId={!isTv ? item.id : undefined}
                        markerDuration={!isTv ? ((item as Movie).fileDuration || (item as Movie).duration) : undefined}
                      />
                    );
                  })}
                </div>
              </ShelfSection>
            ))}
          </>
        )}

        {!isHomeView && selectedLibrary?.type === SectionType.TV && !selectedShow && (
          <ShelfSection
            title="TV Shows"
            description="Select a show to drill into seasons, then open an episode group in the editor."
            headerRight={<ViewModeSelector sectionKey="shows" />}
          >
            {filteredShows.length > 0 ? (
              viewModes.shows === 'table' ? (
                <DynamicTable
                  sectionKey="shows"
                  items={filteredShows}
                  getKey={(show) => show.id}
                  getHref={(show) => buildNavHash({ libraryId: selectedLibrary!.id, showId: show.id })}
                  onClick={(show) => { onResetSearch?.(); void selectShow(show); }}
                />
              ) : viewModes.shows === 'detail' ? (
                <div className="plex-detail-view">
                  {filteredShows.map(show => (
                    <DetailRow
                      key={show.id}
                      title={show.title}
                      meta={`${show.seasonCount} seasons \u2022 ${show.episodeCount} episodes`}
                      secondary={show.summary || undefined}
                      artworkId={show.id}
                      href={buildNavHash({ libraryId: selectedLibrary!.id, showId: show.id })}
                      onClick={() => { onResetSearch?.(); void selectShow(show); }}
                    />
                  ))}
                </div>
              ) : (
                <div
                  className="plex-grid-view"
                  style={{ '--grid-card-width': `${gridSizes.shows}px` } as React.CSSProperties}
                >
                  {filteredShows.map(show => (
                    <PosterTile
                      key={show.id}
                      title={show.title}
                      meta={`${show.seasonCount} seasons`}
                      secondary={`${show.episodeCount} episodes`}
                      badge="Series"
                      artworkId={show.id}
                      href={buildNavHash({ libraryId: selectedLibrary!.id, showId: show.id })}
                      onClick={() => { onResetSearch?.(); void selectShow(show); }}
                    />
                  ))}
                </div>
              )
            ) : (
              <div className="plex-stage-panel p-5 text-sm text-[var(--color-text-muted)]">
                No shows matched this search.
              </div>
            )}
          </ShelfSection>
        )}

        {!isHomeView && selectedLibrary?.type === SectionType.Movie && !selectedMovieId && !selectedShow && (
          <ShelfSection
            title={selectedLibrary.name}
            description="Open a movie to start editing markers or chapters."
            headerRight={<ViewModeSelector sectionKey="movies" />}
          >
            {filteredMovies.length > 0 ? (
              viewModes.movies === 'table' ? (
                <DynamicTable
                  sectionKey="movies"
                  items={filteredMovies}
                  getKey={(movie) => movie.id}
                  getHref={(movie) => buildNavHash({ libraryId: selectedLibrary!.id, movieId: movie.id })}
                  onClick={(movie) => { onResetSearch?.(); selectMovie(movie.id); }}
                />
              ) : viewModes.movies === 'detail' ? (
                <div className="plex-detail-view">
                  {filteredMovies.map(movie => (
                    <DetailRow
                      key={movie.id}
                      title={movie.title}
                      meta={`${movie.year || 'Movie'} \u2022 ${formatDuration(movie.fileDuration || movie.duration)}`}
                      secondary={movie.summary || movie.edition || undefined}
                      artworkId={movie.id}
                      href={buildNavHash({ libraryId: selectedLibrary!.id, movieId: movie.id })}
                      onClick={() => { onResetSearch?.(); selectMovie(movie.id); }}
                      markerItemId={movie.id}
                      markerDuration={movie.fileDuration || movie.duration}
                    />
                  ))}
                </div>
              ) : (
                <div
                  className="plex-grid-view"
                  style={{ '--grid-card-width': `${gridSizes.movies}px` } as React.CSSProperties}
                >
                  {filteredMovies.map(movie => (
                    <PosterTile
                      key={movie.id}
                      title={movie.title}
                      meta={`${movie.year || 'Movie'} \u2022 ${formatDuration(movie.fileDuration || movie.duration)}`}
                      secondary={movie.edition || selectedLibrary.name}
                      badge="Movie"
                      artworkId={movie.id}
                      href={buildNavHash({ libraryId: selectedLibrary!.id, movieId: movie.id })}
                      onClick={() => { onResetSearch?.(); selectMovie(movie.id); }}
                      markerItemId={movie.id}
                      markerDuration={movie.fileDuration || movie.duration}
                    />
                  ))}
                </div>
              )
            ) : (
              <div className="plex-stage-panel p-5 text-sm text-[var(--color-text-muted)]">
                No movies matched this search.
              </div>
            )}
          </ShelfSection>
        )}

        {!isHomeView && selectedShow && !selectedSeason && (
          <ShowDetail show={selectedShow} />
        )}

        {!isHomeView && selectedShow && !selectedSeason && (
          <ShelfSection
            title="Seasons"
            description="Choose the season that contains the episode you want to edit."
            headerRight={<ViewModeSelector sectionKey="seasons" />}
          >
            {filteredSeasons.length > 0 ? (
              viewModes.seasons === 'table' ? (
                <DynamicTable
                  sectionKey="seasons"
                  items={filteredSeasons}
                  getKey={(season) => season.id}
                  getHref={(season) => buildNavHash({ libraryId: selectedLibrary!.id, showId: selectedShow!.id, seasonId: season.id })}
                  onClick={(season) => { onResetSearch?.(); void selectSeason(season); }}
                />
              ) : viewModes.seasons === 'detail' ? (
                <div className="plex-detail-view">
                  {filteredSeasons.map(season => (
                    <DetailRow
                      key={season.id}
                      title={season.title}
                      meta={`${season.episodeCount} episodes`}
                      secondary={selectedShow.title}
                      artworkIds={[season.id, selectedShow?.id ?? season.showId]}
                      href={buildNavHash({ libraryId: selectedLibrary!.id, showId: selectedShow!.id, seasonId: season.id })}
                      onClick={() => { onResetSearch?.(); void selectSeason(season); }}
                    />
                  ))}
                </div>
              ) : (
                <div
                  className="plex-grid-view"
                  style={{ '--grid-card-width': `${gridSizes.seasons}px` } as React.CSSProperties}
                >
                  {filteredSeasons.map(season => (
                    <PosterTile
                      key={season.id}
                      title={season.title}
                      meta={`${season.episodeCount} episodes`}
                      secondary={selectedShow.title}
                      badge={`S${season.index}`}
                      artworkIds={[season.id, selectedShow?.id ?? season.showId]}
                      href={buildNavHash({ libraryId: selectedLibrary!.id, showId: selectedShow!.id, seasonId: season.id })}
                      onClick={() => { onResetSearch?.(); void selectSeason(season); }}
                    />
                  ))}
                </div>
              )
            ) : (
              <div className="plex-stage-panel p-5 text-sm text-[var(--color-text-muted)]">
                No seasons matched this search.
              </div>
            )}
          </ShelfSection>
        )}

        {!isHomeView && selectedSeason && (
          <SeasonDetail season={selectedSeason} show={selectedShow} />
        )}

        {!isHomeView && selectedSeason && (
          <ShelfSection
            title="Episodes"
            description="Episode groups that share the same file stay grouped so marker edits remain file-relative."
            headerRight={<ViewModeSelector sectionKey="episodes" />}
          >
            {filteredEpisodeGroups.length > 0 ? (
              (() => {
                const getEpisodeData = (group: EpisodeGroup) => {
                  const firstEpisode = group.episodes[0];
                  const isMulti = group.episodes.length > 1;
                  const title = isMulti
                    ? group.episodes.map(ep => episodeTitle(ep)).join(' / ')
                    : episodeTitle(firstEpisode);
                  const meta = isMulti
                    ? `${group.episodes.length} episodes \u2022 ${formatDuration(group.totalDuration)}`
                    : `${firstEpisode.showTitle} \u2022 ${formatDuration(group.totalDuration)}`;
                  return { firstEpisode, title, meta };
                };

                if (viewModes.episodes === 'table') {
                  const tableItems = filteredEpisodeGroups.map(group => {
                    const { title, firstEpisode } = getEpisodeData(group);
                    return { ...group, id: firstEpisode.id, title, totalDuration: group.totalDuration, episodeBoundaries: getEpisodeBoundaries(group), _group: group };
                  });
                  return (
                    <DynamicTable
                      sectionKey="episodes"
                      items={tableItems}
                      getKey={(item) => item.groupKey}
                      getHref={(item) => buildNavHash({ libraryId: selectedLibrary!.id, showId: selectedShow!.id, seasonId: selectedSeason!.id, episodeId: item._group.episodes[0].id })}
                      onClick={(item) => { onResetSearch?.(); selectEpisodeGroup(item._group); }}
                    />
                  );
                }

                if (viewModes.episodes === 'detail') {
                  return (
                    <div className="plex-detail-view">
                      {filteredEpisodeGroups.map(group => {
                        const { firstEpisode, title, meta } = getEpisodeData(group);
                        return (
                          <DetailRow
                            key={group.groupKey}
                            title={title}
                            meta={meta}
                            secondary={selectedSeason.title}
                            artworkIds={[firstEpisode.id, selectedSeason.id ?? firstEpisode.seasonId, selectedShow?.id ?? firstEpisode.showId]}
                            href={buildNavHash({ libraryId: selectedLibrary!.id, showId: selectedShow!.id, seasonId: selectedSeason!.id, episodeId: firstEpisode.id })}
                            onClick={() => { onResetSearch?.(); selectEpisodeGroup(group); }}
                            wide
                            markerItemId={firstEpisode.id}
                            markerDuration={group.totalDuration}
                            episodeBoundaries={getEpisodeBoundaries(group)}
                          />
                        );
                      })}
                    </div>
                  );
                }

                return (
                  <div
                    className="plex-grid-view"
                    style={{ '--grid-card-width': `${gridSizes.episodes}px` } as React.CSSProperties}
                  >
                    {filteredEpisodeGroups.map(group => {
                      const { firstEpisode, title, meta } = getEpisodeData(group);
                      return (
                        <PosterTile
                          key={group.groupKey}
                          title={title}
                          meta={meta}
                          secondary={selectedSeason.title}
                          badge={group.label}
                          artworkIds={[firstEpisode.id, selectedSeason.id ?? firstEpisode.seasonId, selectedShow?.id ?? firstEpisode.showId]}
                          href={buildNavHash({ libraryId: selectedLibrary!.id, showId: selectedShow!.id, seasonId: selectedSeason!.id, episodeId: firstEpisode.id })}
                          onClick={() => { onResetSearch?.(); selectEpisodeGroup(group); }}
                          wide
                          markerItemId={firstEpisode.id}
                          markerDuration={group.totalDuration}
                          episodeBoundaries={getEpisodeBoundaries(group)}
                        />
                      );
                    })}
                  </div>
                );
              })()
            ) : (
              <div className="plex-stage-panel p-5 text-sm text-[var(--color-text-muted)]">
                No episodes matched this search.
              </div>
            )}
          </ShelfSection>
        )}
      </div>
    </div>
  );
}

function EditorWorkspace() {
  const {
    selectedLibrary,
    selectedShow,
    selectedSeason,
    selectedEpisodeId,
    selectedMovieId,
    selectedEpisodeGroup,
    episodes,
    movies,
    selectShow,
    selectSeason,
  } = useLibraryStore();
  const { markers, loadMarkers, loadMarkersForGroup, loading, error } = useMarkerStore();
  const { chapters, loadChapters, loading: chaptersLoading } = useChapterStore();
  const playbackMode = useSettingsStore(s => s.playbackMode);
  const syncPlayback = usePlaybackStore(s => s.syncPlayback);
  const detachPlayback = usePlaybackStore(s => s.detachPlayback);
  const storedPlaybackActive = usePlaybackStore(s => s.active);
  const storedPlaybackMedia = usePlaybackStore(s => s.media);
  const storedPlaybackTime = usePlaybackStore(s => s.currentTime);
  const storedPlaybackIsPlaying = usePlaybackStore(s => s.isPlaying);
  const storedPlaybackVolume = usePlaybackStore(s => s.volume);
  const storedPlaybackMuted = usePlaybackStore(s => s.muted);
  const storedPlaybackRate = usePlaybackStore(s => s.playbackRate);
  const storedMirrorStream = usePlaybackStore(s => s.mirrorStream);
  const plexConfigured = useSystemStore(s => s.status?.plexConfigured ?? false);

  const selectedId = selectedEpisodeId || selectedMovieId;
  const storedPlaybackResume = getStoredPlaybackResume(
    storedPlaybackMedia,
    selectedEpisodeId,
    selectedMovieId,
    storedPlaybackActive,
    storedPlaybackTime,
    storedPlaybackIsPlaying,
    storedPlaybackVolume,
    storedPlaybackMuted,
    storedPlaybackRate,
  );

  const [showForm, setShowForm] = useState(false);
  const [editingMarker, setEditingMarker] = useState<Marker | null>(null);
  const [showChapterForm, setShowChapterForm] = useState(false);
  const [editingChapterIndex, setEditingChapterIndex] = useState<number | null>(null);
  const [currentTime, setCurrentTime] = useState(storedPlaybackResume?.seekMs ?? 0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [playerReady, setPlayerReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(storedPlaybackResume?.autoPlay ?? false);
  const [volume, setVolume] = useState(storedPlaybackResume?.volume ?? storedPlaybackVolume);
  const [muted, setMuted] = useState(storedPlaybackResume?.muted ?? storedPlaybackMuted);
  const [playbackRate, setPlaybackRate] = useState(storedPlaybackResume?.playbackRate ?? storedPlaybackRate);
  const [mediaInfo, setMediaInfo] = useState<(MediaInfo & { fileExists: boolean }) | null>(null);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [fallbackResume, setFallbackResume] = useState<{ autoPlay: boolean; seekMs: number } | null>(null);
  const [pendingStart, setPendingStart] = useState<number | null>(null);
  const [pendingEnd, setPendingEnd] = useState<number | null>(null);
  const [pendingType, setPendingType] = useState<string | null>(null);
  const [boundaryDurations, setBoundaryDurations] = useState<number[] | null>(null);
  const [boundaryEditing, setBoundaryEditing] = useState(false);
  const [boundarySaving, setBoundarySaving] = useState(false);

  const playerRef = useRef<VideoPlayerHandle>(null);
  const playbackOwnerIdRef = useRef(createPlaybackOwnerId('editor'));
  const lastPlayerSessionKeyRef = useRef<string | null>(null);
  const latestPlaybackRef = useRef<{
    playbackMedia: PlaybackMedia | null;
    duration: number;
    currentTime: number;
    isPlaying: boolean;
    volume: number;
    muted: boolean;
    playbackRate: number;
  }>({
    playbackMedia: storedPlaybackMedia,
    duration: 0,
    currentTime: storedPlaybackResume?.seekMs ?? 0,
    isPlaying: storedPlaybackResume?.autoPlay ?? false,
    volume: storedPlaybackResume?.volume ?? storedPlaybackVolume,
    muted: storedPlaybackResume?.muted ?? storedPlaybackMuted,
    playbackRate: storedPlaybackResume?.playbackRate ?? storedPlaybackRate,
  });

  if (!selectedId) {
    return null;
  }

  const groupEpisodesForEditor = useMemo<Episode[]>(() => {
    if (selectedEpisodeGroup) {
      return selectedEpisodeGroup;
    }

    if (!selectedEpisodeId) {
      return [];
    }

    return episodes.filter(entry => entry.id === selectedEpisodeId);
  }, [episodes, selectedEpisodeGroup, selectedEpisodeId]);
  const isMultiEpisode = groupEpisodesForEditor.length > 1;

  const episode = episodes.find(e => e.id === selectedEpisodeId);
  const movie = movies.find(m => m.id === selectedMovieId);

  const groupTotalDuration = isMultiEpisode ? groupEpisodesForEditor.reduce((sum, entry) => sum + entry.duration, 0) : 0;
  const movieFileDuration = movie && movie.fileDuration > 0 ? movie.fileDuration : movie?.duration || 0;
  const duration = isMultiEpisode
    ? (videoDuration || groupTotalDuration)
    : (videoDuration || (episode?.fileDuration || episode?.duration) || movieFileDuration || 0);

  const title = isMultiEpisode
    ? `S${groupEpisodesForEditor[0].seasonIndex}E${String(groupEpisodesForEditor[0].index).padStart(2, '0')}-E${String(groupEpisodesForEditor[groupEpisodesForEditor.length - 1].index).padStart(2, '0')}`
    : episode
      ? `S${episode.seasonIndex}E${episode.index}`
      : movie?.title || '';

  const fullTitle = isMultiEpisode
    ? groupEpisodesForEditor.map(entry => episodeTitle(entry)).join(' / ')
    : episode ? episodeTitle(episode) : movie?.title ?? '';

  const subtitle = episode ? episode.showTitle : movie?.year ? `${movie.year}` : '';
  const showSecondaryTitle = Boolean(fullTitle && title && fullTitle !== title);

  const playbackTarget = useMemo(() => {
    if (!selectedLibrary) return null;

    return {
      library: selectedLibrary,
      show: selectedShow,
      season: selectedSeason,
      episodeId: selectedEpisodeId,
      movieId: selectedMovieId,
    };
  }, [selectedEpisodeId, selectedLibrary, selectedMovieId, selectedSeason, selectedShow]);

  const playbackDisplay = useMemo(() => {
    if (movie) {
      return {
        artworkIds: [movie.id],
        title: movie.title,
        subtitle: movie.year
          ? `${movie.year}${movie.edition ? ` • ${movie.edition}` : ''}`
          : (movie.edition || 'Movie'),
      };
    }

    const primaryEpisode = groupEpisodesForEditor[0] ?? episode;
    if (!primaryEpisode) return null;

    if (isMultiEpisode) {
      const lastEpisode = groupEpisodesForEditor[groupEpisodesForEditor.length - 1];
      return {
        artworkIds: [primaryEpisode.id, primaryEpisode.seasonId, primaryEpisode.showId],
        title: primaryEpisode.showTitle,
        subtitle: `E${String(primaryEpisode.index).padStart(2, '0')}-E${String(lastEpisode.index).padStart(2, '0')} — ${groupEpisodesForEditor.map(entry => episodeTitle(entry)).join(' / ')}`,
      };
    }

    return {
      artworkIds: [primaryEpisode.id, primaryEpisode.seasonId, primaryEpisode.showId],
      title: primaryEpisode.showTitle,
      subtitle: `S${primaryEpisode.seasonIndex} • E${String(primaryEpisode.index).padStart(2, '0')} — ${primaryEpisode.title}`,
    };
  }, [
    episode,
    groupEpisodesForEditor,
    isMultiEpisode,
    movie,
  ]);

  const episodeBoundaries = useMemo<EpisodeBoundary[]>(() => {
    if (!isMultiEpisode) return [];
    const durations = boundaryDurations || groupEpisodesForEditor.map(entry => entry.duration);
    const boundaries: EpisodeBoundary[] = [];
    let offset = 0;
    for (let index = 0; index < durations.length - 1; index += 1) {
      offset += durations[index];
      const currentEpisode = groupEpisodesForEditor[index];
      const nextEpisode = groupEpisodesForEditor[index + 1];
      boundaries.push({
        position: offset,
        label: `E${String(currentEpisode.index).padStart(2, '0')} | E${String(nextEpisode.index).padStart(2, '0')}`,
      });
    }
    return boundaries;
  }, [boundaryDurations, groupEpisodesForEditor, isMultiEpisode]);

  useEffect(() => {
    if (!selectedId) return;
    setCurrentTime(storedPlaybackResume?.seekMs ?? 0);
    setVideoDuration(0);
    setIsPlaying(storedPlaybackResume?.autoPlay ?? false);
    setVolume(storedPlaybackResume?.volume ?? storedPlaybackVolume);
    setMuted(storedPlaybackResume?.muted ?? storedPlaybackMuted);
    setPlaybackRate(storedPlaybackResume?.playbackRate ?? storedPlaybackRate);
    if (isMultiEpisode) {
      void loadMarkersForGroup(groupEpisodesForEditor.map(entry => entry.id));
    } else {
      void loadMarkers(selectedId);
    }
    void loadChapters(selectedId);
    setMediaLoading(true);
    setMediaInfo(null);
    setBoundaryDurations(null);
    setBoundaryEditing(false);

    api.getMediaInfo(selectedId)
      .then(info => setMediaInfo(info))
      .catch(() => setMediaInfo(null))
      .finally(() => setMediaLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, isMultiEpisode ? groupEpisodesForEditor.map(entry => entry.id).join(',') : '']);

  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

  const availableModes = useMemo(() => {
    return getModeSequence(playbackMode, mediaInfo, plexConfigured, isSafari);
  }, [isSafari, mediaInfo, playbackMode, plexConfigured]);

  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    setActiveIndex(0);
    setFallbackResume(null);
  }, [selectedId, mediaInfo, availableModes]);

  const autoMode = availableModes.length > 0
    ? availableModes[Math.min(activeIndex, Math.max(0, availableModes.length - 1))]
    : undefined;

  const hasNextMode = activeIndex < availableModes.length - 1;

  const handlePlaybackFailed = useCallback((context: PlaybackFailureContext) => {
    setFallbackResume({
      autoPlay: context.attemptedToPlay,
      seekMs: Math.max(0, context.currentTimeMs),
    });
    setActiveIndex(current => Math.min(current + 1, Math.max(0, availableModes.length - 1)));
  }, [availableModes.length]);

  const MODE_LABELS: Record<VideoSourceMode, string> = {
    direct: 'Direct file',
    'plex-api': 'Plex API',
    'plex-transcode': 'Plex Transcode (Standard)',
    'plex-transcode-full': 'Plex Transcode (Full)',
    'plex-transcode-safe': 'Plex Transcode (Safe)',
  };

  const videoSrcType = (
    autoMode === 'plex-transcode'
    || autoMode === 'plex-transcode-full'
    || autoMode === 'plex-transcode-safe'
  )
    ? 'application/x-mpegURL'
    : 'video/mp4';

  const transcodeSessionId = useMemo(() => {
    if (!selectedId || !autoMode || !isInternalTranscodeMode(autoMode)) return undefined;
    return createTranscodeSessionId(selectedId);
  }, [selectedId, autoMode, activeIndex]);

  const videoSrc = useMemo(() => {
    if (!selectedId || !mediaInfo || !autoMode) return '';
    if (autoMode === 'plex-transcode') return api.getPlexTranscodeUrl(selectedId, transcodeSessionId);
    if (autoMode === 'plex-transcode-full') return api.getPlexFullTranscodeUrl(selectedId, transcodeSessionId);
    if (autoMode === 'plex-transcode-safe') return api.getPlexSafeTranscodeUrl(selectedId, transcodeSessionId);
    if (autoMode === 'plex-api') return api.getPlexStreamUrl(selectedId);
    return api.getDirectStreamUrl(selectedId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, mediaInfo, autoMode, activeIndex, transcodeSessionId]);

  const playbackMedia = useMemo(() => {
    if (!playbackTarget || !playbackDisplay) return null;

    return {
      ...playbackDisplay,
      target: playbackTarget,
      player: videoSrc
        ? {
            src: videoSrc,
            sourceType: videoSrcType,
            frameRate: mediaInfo?.frameRate ?? null,
            startOffset: isMultiEpisode ? 0 : (mediaInfo?.startOffset || 0),
            episodeDuration: isMultiEpisode
              ? undefined
              : (episode?.fileDuration || episode?.duration || movie?.fileDuration || movie?.duration || undefined),
          }
        : null,
    };
  }, [
    episode,
    isMultiEpisode,
    mediaInfo,
    movie,
    playbackDisplay,
    playbackTarget,
    videoSrc,
    videoSrcType,
  ]);

  const playerSessionKey = `${selectedId ?? 'none'}|${videoSrcType}|${videoSrc || 'none'}`;

  useLayoutEffect(() => {
    if (lastPlayerSessionKeyRef.current === playerSessionKey) {
      return;
    }

    lastPlayerSessionKeyRef.current = playerSessionKey;
    setPlayerReady(false);
    setCurrentTime(fallbackResume?.seekMs ?? storedPlaybackResume?.seekMs ?? 0);
    setVideoDuration(0);
    setIsPlaying(fallbackResume?.autoPlay ?? storedPlaybackResume?.autoPlay ?? false);
    setVolume(storedPlaybackResume?.volume ?? storedPlaybackVolume);
    setMuted(storedPlaybackResume?.muted ?? storedPlaybackMuted);
    setPlaybackRate(storedPlaybackResume?.playbackRate ?? storedPlaybackRate);
  }, [
    fallbackResume?.autoPlay,
    fallbackResume?.seekMs,
    playerSessionKey,
    storedPlaybackMuted,
    storedPlaybackRate,
    storedPlaybackResume?.autoPlay,
    storedPlaybackResume?.muted,
    storedPlaybackResume?.playbackRate,
    storedPlaybackResume?.seekMs,
    storedPlaybackResume?.volume,
    storedPlaybackVolume,
  ]);

  useEffect(() => {
    latestPlaybackRef.current = {
      playbackMedia,
      duration,
      currentTime,
      isPlaying,
      volume,
      muted,
      playbackRate,
    };
  }, [currentTime, duration, isPlaying, muted, playbackMedia, playbackRate, volume]);

  const handleDockTogglePlay = useCallback(() => {
    playerRef.current?.togglePlay();
  }, []);

  const handleDockSeekBy = useCallback((offsetMs: number) => {
    playerRef.current?.seekBy(offsetMs);
  }, []);

  const handleDockSeekTo = useCallback((ms: number) => {
    playerRef.current?.seekTo(ms);
  }, []);

  const handleDockStop = useCallback(() => {
    playerRef.current?.stop();
  }, []);

  const handlePlaybackStateChange = useCallback((state: PlaybackStateChange) => {
    setPlayerReady(state.canControl);
    setIsPlaying(state.isPlaying);
    setVolume(state.volume);
    setMuted(state.muted);
    setPlaybackRate(state.playbackRate);
  }, []);

  useEffect(() => {
    syncPlayback({
      media: playbackMedia,
      ownerId: playbackMedia ? playbackOwnerIdRef.current : null,
      canControl: playerReady && Boolean(videoSrc),
      isPlaying,
      currentTime,
      duration,
      volume,
      muted,
      playbackRate,
      togglePlay: playerReady && videoSrc ? handleDockTogglePlay : null,
      seekBy: playerReady && videoSrc ? handleDockSeekBy : null,
      seekTo: playerReady && videoSrc ? handleDockSeekTo : null,
      stop: videoSrc ? handleDockStop : null,
    });
  }, [
    currentTime,
    duration,
    handleDockSeekBy,
    handleDockSeekTo,
    handleDockStop,
    handleDockTogglePlay,
    isPlaying,
    muted,
    playerReady,
    playbackRate,
    playbackMedia,
    syncPlayback,
    videoSrc,
    volume,
  ]);

  useEffect(() => {
    if (!videoSrc || !playbackMedia || !playerReady) {
      if (storedMirrorStream) {
        syncPlayback({ mirrorStream: null });
      }
      return;
    }

    if (storedMirrorStream) {
      return;
    }

    const mirrorStream = playerRef.current?.getMirrorStream() ?? null;
    if (!mirrorStream) {
      return;
    }

    syncPlayback({
      media: playbackMedia,
      ownerId: playbackOwnerIdRef.current,
      mirrorStream,
    });
  }, [playbackMedia, playerReady, storedMirrorStream, syncPlayback, videoSrc]);

  useEffect(() => {
    return () => {
      syncPlayback({ mirrorStream: null });
    };
  }, [playbackMedia, syncPlayback, videoSrc]);

  useLayoutEffect(() => {
    return () => {
      const snapshot = playerRef.current?.getSyncState();
      const latest = latestPlaybackRef.current;
      const store = usePlaybackStore.getState();
      const latestIdentity = getPlaybackIdentity(latest.playbackMedia);

      if (!latestIdentity || store.ownerId !== playbackOwnerIdRef.current || getPlaybackIdentity(store.media) !== latestIdentity) {
        return;
      }

      if (latest.playbackMedia && snapshot) {
        syncPlayback({
          media: latest.playbackMedia,
          ownerId: playbackOwnerIdRef.current,
          currentTime: snapshot.currentTimeMs,
          isPlaying: snapshot.isPlaying,
          duration: latest.duration,
          volume: snapshot.volume,
          muted: snapshot.muted,
          playbackRate: snapshot.playbackRate,
        });
      } else if (latest.playbackMedia) {
        syncPlayback({
          media: latest.playbackMedia,
          ownerId: playbackOwnerIdRef.current,
          currentTime: latest.currentTime,
          isPlaying: latest.isPlaying,
          duration: latest.duration,
          volume: latest.volume,
          muted: latest.muted,
          playbackRate: latest.playbackRate,
        });
      }

      detachPlayback(playbackOwnerIdRef.current);
    };
  }, [detachPlayback, syncPlayback]);

  const handleSeek = useCallback((ms: number) => {
    playerRef.current?.seekTo(ms);
  }, []);

  const handleEdit = (marker: Marker) => {
    setEditingMarker(marker);
    setPendingStart(null);
    setPendingEnd(null);
    setShowForm(true);
  };

  const handleAddNew = () => {
    setEditingMarker(null);
    setPendingStart(null);
    setPendingEnd(null);
    setShowForm(true);
  };

  const suggestMarkerType = (ms: number): string => {
    if (duration <= 0) return 'intro';
    const ratio = ms / duration;
    if (ratio <= 0.25) return 'intro';
    if (ratio >= 0.75) return 'credits';
    return 'commercial';
  };

  const handleSetStart = (ms: number) => {
    setPendingStart(ms);
    if (!showForm) {
      setPendingType(suggestMarkerType(ms));
      setEditingMarker(null);
      setShowForm(true);
    }
  };

  const handleSetEnd = (ms: number) => {
    setPendingEnd(ms);
    if (!showForm) {
      setPendingType(suggestMarkerType(ms));
      setEditingMarker(null);
      setShowForm(true);
    }
  };

  const handleSaved = () => {
    if (isMultiEpisode) {
      void loadMarkersForGroup(groupEpisodesForEditor.map(entry => entry.id));
    } else if (selectedId) {
      void loadMarkers(selectedId);
    }
    setPendingStart(null);
    setPendingEnd(null);
    setPendingType(null);
    void useLibraryStore.getState().refreshMarkerSummary();
  };

  const handleJump = useCallback((ms: number) => {
    playerRef.current?.seekTo(ms);
  }, []);

  const handleEditChapter = (index: number) => {
    setEditingChapterIndex(index);
    setShowChapterForm(true);
  };

  const handleAddChapter = () => {
    setEditingChapterIndex(null);
    setShowChapterForm(true);
  };

  const handleChapterSaved = () => {
    if (selectedId) void loadChapters(selectedId);
  };

  const handleBoundaryDrag = useCallback((index: number, newPosition: number) => {
    if (!isMultiEpisode) return;
    const durations = boundaryDurations || groupEpisodesForEditor.map(entry => entry.duration);
    const newDurations = [...durations];

    let offsetBefore = 0;
    for (let boundaryIndex = 0; boundaryIndex < index; boundaryIndex += 1) {
      offsetBefore += newDurations[boundaryIndex];
    }

    const budget = newDurations[index] + newDurations[index + 1];
    const newDuration = Math.max(1000, Math.min(budget - 1000, newPosition - offsetBefore));
    newDurations[index] = Math.round(newDuration);
    newDurations[index + 1] = Math.round(budget - newDuration);

    setBoundaryDurations(newDurations);
    setBoundaryEditing(true);
  }, [boundaryDurations, groupEpisodesForEditor, isMultiEpisode]);

  const handleBoundarySave = async () => {
    if (!boundaryDurations || !isMultiEpisode) return;
    setBoundarySaving(true);
    try {
      await Promise.all(
        groupEpisodesForEditor.map((entry, index) => api.updateEpisodeDuration(entry.id, boundaryDurations[index])),
      );

      const season = useLibraryStore.getState().selectedSeason;
      if (season) {
        const [freshEpisodes, summaryRaw] = await Promise.all([
          api.getEpisodesBySeason(season.id),
          api.getSeasonMarkerSummary(season.id),
        ]);

        const freshSummary: Record<number, import('../../api/client').MarkerSummaryEntry[]> = {};
        for (const [id, entries] of Object.entries(summaryRaw)) {
          freshSummary[Number(id)] = entries;
        }

        const groupIds = new Set(groupEpisodesForEditor.map(entry => entry.id));
        const freshGroup = freshEpisodes.filter(entry => groupIds.has(entry.id));
        useLibraryStore.setState({
          episodes: freshEpisodes,
          markerSummary: freshSummary,
          selectedEpisodeGroup: freshGroup.length > 1 ? freshGroup : null,
        });
      }

      setBoundaryEditing(false);
      setBoundaryDurations(null);
    } finally {
      setBoundarySaving(false);
    }
  };

  const handleBoundaryReset = () => {
    setBoundaryDurations(null);
    setBoundaryEditing(false);
  };

  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <div className="px-5 md:px-8 xl:px-10 py-6 md:py-8 space-y-6">
        <section className="plex-stage-panel p-5 md:p-6 lg:p-7">
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div className="space-y-2">
                <button
                  onClick={() => {
                    if (selectedEpisodeId && selectedSeason) {
                      void selectSeason(selectedSeason);
                    } else if (selectedMovieId && selectedLibrary) {
                      useLibraryStore.setState({ selectedMovieId: null, selectedEpisodeGroup: null });
                    }
                  }}
                  className="ctrl-btn mb-1"
                >
                  <ChevronLeftIcon />
                  {selectedEpisodeId ? 'Episodes' : selectedLibrary?.name || 'Back'}
                </button>
                <div className="plex-kicker">Editing</div>
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="plex-display-title">{title || fullTitle}</h1>
                  {showSecondaryTitle && <span className="text-sm text-[var(--color-text-muted)]">{fullTitle}</span>}
                </div>
                <p className="text-sm md:text-base text-[var(--color-text-muted)]">
                  {[subtitle, mediaInfo?.container?.toUpperCase(), autoMode ? MODE_LABELS[autoMode] : undefined].filter(Boolean).join(' • ') || 'Marker editor'}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button onClick={handleAddNew} className="ctrl-btn ctrl-btn-accent">
                  <MarkerIcon />
                  Add Marker
                </button>
              </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_320px]">
              <div className="space-y-4">
                <div>
                  <div>
                    {mediaLoading ? (
                      <div className="w-full h-full flex items-center justify-center text-sm text-[var(--color-text-muted)]">
                        Loading media info…
                      </div>
                    ) : videoSrc ? (
                      <VideoPlayer
                        key={playerSessionKey}
                        ref={playerRef}
                        src={videoSrc}
                        sourceType={videoSrcType}
                        frameRate={mediaInfo?.frameRate}
                        markers={markers}
                        chapters={chapters}
                        startOffset={isMultiEpisode ? 0 : (mediaInfo?.startOffset || 0)}
                        episodeDuration={isMultiEpisode ? undefined : (episode?.fileDuration || episode?.duration || movie?.fileDuration || movie?.duration || undefined)}
                        episodeBoundaries={episodeBoundaries.length > 0 ? episodeBoundaries : undefined}
                        onBoundaryDrag={isMultiEpisode ? handleBoundaryDrag : undefined}
                        onTimeUpdate={setCurrentTime}
                        onDurationChange={setVideoDuration}
                        onPlaybackStateChange={handlePlaybackStateChange}
                        onSetStart={handleSetStart}
                        onSetEnd={handleSetEnd}
                        resumeFromMs={fallbackResume?.seekMs ?? storedPlaybackResume?.seekMs ?? null}
                        autoPlayOnLoad={fallbackResume?.autoPlay ?? storedPlaybackResume?.autoPlay ?? false}
                        sessionVolume={volume}
                        sessionMuted={muted}
                        sessionPlaybackRate={playbackRate}
                        onPlaybackFailed={hasNextMode ? handlePlaybackFailed : undefined}
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center px-6 text-center text-sm text-[var(--color-text-muted)]">
                        <span className="plex-kicker">Playback</span>
                        <p className="mt-3">
                          {mediaInfo
                            ? 'No video source is available for this title in the current playback mode.'
                            : 'Media file not found in Plex database.'}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {isMultiEpisode && (
                  <div className="plex-editor-section p-4 space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="plex-kicker">Boundary Editor</div>
                        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                          Drag boundaries in the player or set exact times below.
                        </p>
                      </div>

                      {boundaryEditing && (
                        <div className="flex items-center gap-2">
                          <button onClick={handleBoundaryReset} className="ctrl-btn">Reset</button>
                          <button onClick={handleBoundarySave} disabled={boundarySaving} className="ctrl-btn ctrl-btn-accent">
                            {boundarySaving ? 'Saving…' : 'Save Boundaries'}
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {groupEpisodesForEditor.map((entry, index) => {
                        const durations = boundaryDurations || groupEpisodesForEditor.map(item => item.duration);
                        let offset = 0;
                        for (let pointer = 0; pointer < index; pointer += 1) {
                          offset += durations[pointer];
                        }
                        const endTime = offset + durations[index];
                        const canEdit = index < groupEpisodesForEditor.length - 1;

                        return (
                          <div key={entry.id} className="rounded-2xl border border-white/7 bg-white/4 p-4 space-y-3">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <div className="plex-kicker">Episode {String(entry.index).padStart(2, '0')}</div>
                                <div className="mt-1 text-sm font-semibold text-white">{episodeTitle(entry)}</div>
                              </div>
                              <div className="timecode text-xs text-[var(--color-text-muted)]">{formatDuration(durations[index])}</div>
                            </div>

                            <div className="text-xs text-[var(--color-text-muted)]">
                              {formatTimeFull(offset)} → {formatTimeFull(endTime)}
                            </div>

                            {canEdit && (
                              <div className="flex items-center gap-2">
                                <BoundaryInput
                                  value={endTime}
                                  onChange={ms => handleBoundaryDrag(index, ms)}
                                  min={offset + 1000}
                                />
                                <button onClick={() => handleSeek(endTime)} className="ctrl-btn px-3">Jump</button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <aside className="plex-editor-section p-5 space-y-5">
                <div>
                  <div className="plex-kicker">Playback</div>
                  <div className="mt-3 space-y-2 text-sm text-[var(--color-text-muted)]">
                    <div className="flex items-center justify-between gap-3">
                      <span>Current Time</span>
                      <span className="timecode text-white">{formatTimeFull(currentTime)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Duration</span>
                      <span className="timecode text-white">{formatTimeFull(duration)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Mode</span>
                      <span className="text-white">{autoMode ? MODE_LABELS[autoMode] : 'Unavailable'}</span>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="plex-kicker">Media</div>
                  <div className="mt-3 space-y-2 text-sm text-[var(--color-text-muted)]">
                    <div className="flex items-center justify-between gap-3">
                      <span>Container</span>
                      <span className="text-white">{mediaInfo?.container?.toUpperCase() || '—'}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Video</span>
                      <span className="text-white">{mediaInfo?.videoCodec?.toUpperCase() || '—'}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Audio</span>
                      <span className="text-white">{mediaInfo?.audioCodec?.toUpperCase() || '—'}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Resolution</span>
                      <span className="text-white">{mediaInfo ? `${mediaInfo.width}×${mediaInfo.height}` : '—'}</span>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="plex-kicker">Quick Facts</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className="plex-pill">
                      <MarkerIcon />
                      {markers.length} markers
                    </span>
                    <span className="plex-pill">
                      <DatabaseIcon />
                      {chapters.length} chapters
                    </span>
                  </div>
                </div>

                {(error || (!mediaInfo?.fileExists && !plexConfigured)) && (
                  <div className="rounded-2xl border border-amber-400/20 bg-amber-500/10 p-4 text-sm text-amber-200/85">
                    {error || 'The media file is not available on local disk and Plex playback is unavailable.'}
                  </div>
                )}
              </aside>
            </div>
          </div>
        </section>

        <section className="plex-editor-section p-4 md:p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="plex-kicker">Markers</div>
              <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                Review, edit, and jump directly to marker ranges.
              </p>
            </div>
          </div>

          {loading ? (
            <div className="py-10 text-center text-sm text-[var(--color-text-muted)]">Loading markers…</div>
          ) : error ? (
            <div className="py-10 text-center text-sm text-red-300/85">{error}</div>
          ) : (
            <MarkerTable markers={markers} onEdit={handleEdit} onJump={handleJump} onDeleted={handleSaved} />
          )}
        </section>

        <section className="plex-editor-section p-4 md:p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="plex-kicker">Chapters</div>
              <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                Maintain chapters alongside markers in the same workspace.
              </p>
            </div>
            <button onClick={handleAddChapter} className="ctrl-btn ctrl-btn-accent">Add Chapter</button>
          </div>

          {chaptersLoading ? (
            <div className="py-10 text-center text-sm text-[var(--color-text-muted)]">Loading chapters…</div>
          ) : (
            <ChapterTable
              chapters={chapters}
              metadataId={selectedId}
              onEdit={handleEditChapter}
              onJump={handleJump}
              onSaved={handleChapterSaved}
            />
          )}
        </section>
      </div>

      {showForm && (
        <MarkerForm
          marker={editingMarker}
          parentId={selectedId}
          initialStart={pendingStart}
          initialEnd={pendingEnd}
          initialType={pendingType}
          duration={duration}
          onGetCurrentTime={() => playerRef.current?.getCurrentTime() ?? 0}
          onClose={() => {
            setShowForm(false);
            setEditingMarker(null);
            setPendingStart(null);
            setPendingEnd(null);
            setPendingType(null);
          }}
          onSaved={handleSaved}
        />
      )}

      {showChapterForm && (
        <ChapterForm
          editIndex={editingChapterIndex}
          allChapters={chapters}
          metadataId={selectedId}
          onGetCurrentTime={() => playerRef.current?.getCurrentTime() ?? 0}
          onClose={() => {
            setShowChapterForm(false);
            setEditingChapterIndex(null);
          }}
          onSaved={handleChapterSaved}
        />
      )}
    </div>
  );
}

function BoundaryInput({
  value,
  onChange,
  min,
}: {
  value: number;
  onChange: (ms: number) => void;
  min: number;
}) {
  const [text, setText] = useState(formatTimeFull(value));

  useEffect(() => {
    setText(formatTimeFull(value));
  }, [value]);

  return (
    <input
      type="text"
      value={text}
      onChange={event => setText(event.target.value)}
      onBlur={() => {
        const parsed = parseTime(text);
        if (parsed !== null && parsed >= min) {
          onChange(parsed);
        } else {
          setText(formatTimeFull(value));
        }
      }}
      className="plex-input timecode min-w-0"
    />
  );
}
