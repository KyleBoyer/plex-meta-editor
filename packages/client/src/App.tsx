import { useState, useEffect, useCallback, useRef, useMemo, useDeferredValue } from 'react';
import { type Library, type LibrarySearchResult, type Show } from '@plex-meta-editor/shared';
import { Sidebar } from './components/layout/Sidebar';
import { MainContent } from './components/layout/MainContent';
import { StatusBar } from './components/layout/StatusBar';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { ArtworkImage } from './components/media/ArtworkImage';
import { LoginScreen } from './components/auth/LoginScreen';
import { api } from './api/client';
import { restoreFromHash, buildNavHash, handleNavClick } from './stores/library';
import { useLibraryStore } from './stores/library';
import { usePlaybackStore } from './stores/playback';
import { useSystemStore } from './stores/system';
import { useAuthStore } from './stores/auth';
import { useSettingsStore } from './stores/settings';

const DEFAULT_SIDEBAR_WIDTH = 260;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 320;
const COLLAPSED_SIDEBAR_WIDTH = 64;

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 900);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 899px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return isMobile;
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="7.5" />
      <path d="m20 20-4-4" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M6 6 18 18M18 6 6 18" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="3.25" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .32 1.82l.03.03a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.03-.03a1.6 1.6 0 0 0-1.82-.32 1.6 1.6 0 0 0-.98 1.48V21a2 2 0 0 1-4 0v-.05a1.6 1.6 0 0 0-.98-1.48 1.6 1.6 0 0 0-1.82.32l-.03.03a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.03-.03A1.6 1.6 0 0 0 4.6 15a1.6 1.6 0 0 0-1.48-.98H3a2 2 0 0 1 0-4h.12A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.32-1.82l-.03-.03a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.03.03A1.6 1.6 0 0 0 8.93 4a1.6 1.6 0 0 0 .98-1.48V2.5a2 2 0 0 1 4 0V2.52A1.6 1.6 0 0 0 14.9 4a1.6 1.6 0 0 0 1.82-.32l.03-.03a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.03.03A1.6 1.6 0 0 0 19.4 9a1.6 1.6 0 0 0 1.48.98H21a2 2 0 0 1 0 4h-.12A1.6 1.6 0 0 0 19.4 15Z" />
    </svg>
  );
}

function SearchResultOpenIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="m10 8 6 4-6 4V8Z" fill="currentColor" stroke="none" />
    </svg>
  );
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

function SearchDropdownRow({
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

  return (
    <a href={href || '#'} onClick={e => handleNavClick(e, onOpen)} className="plex-search-dropdown-row">
      <div className="plex-search-dropdown-thumb">
        <ArtworkImage
          metadataId={result.id}
          alt={result.title}
          className="plex-search-dropdown-thumb-image"
          loading="lazy"
          fallback={<div className="plex-artwork-fallback" />}
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="plex-search-dropdown-title">{result.title}</div>
        <div className="plex-search-dropdown-meta">{meta}</div>
        <div className="plex-search-dropdown-library">{result.libraryName}</div>
      </div>

      <span className="plex-search-dropdown-action" aria-hidden="true">
        <SearchResultOpenIcon />
      </span>
    </a>
  );
}

export default function App() {
  const { isAuthenticated, isLoading: authLoading, checkSession, user } = useAuthStore();

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  if (authLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[var(--color-page-background)]">
        <div className="flex flex-col items-center gap-3">
          <svg
            className="animate-spin text-[var(--color-accent)]"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
          </svg>
          <span className="text-sm text-[var(--color-text-faint)]">Loading...</span>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  return <AuthenticatedApp />;
}

function AuthenticatedApp() {
  const { user, logout } = useAuthStore();
  const [showSettings, setShowSettings] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarHovered, setSidebarHovered] = useState(false);
  const [searchDropdownOpen, setSearchDropdownOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<LibrarySearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const overlayColors = useSettingsStore(s => s.overlayColors);

  // Sync custom overlay colors to CSS variables
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--color-marker-intro', overlayColors.intro);
    root.style.setProperty('--color-marker-credits', overlayColors.credits);
    root.style.setProperty('--color-marker-commercial', overlayColors.commercial);
  }, [overlayColors]);

  const searchQuery = useLibraryStore(s => s.searchQuery);
  const searchExpanded = useLibraryStore(s => s.searchExpanded);
  const storeSetSearchQuery = useLibraryStore(s => s.setSearchQuery);
  const storeSetSearchExpanded = useLibraryStore(s => s.setSearchExpanded);
  const storeResetSearch = useLibraryStore(s => s.resetSearch);
  const layoutRef = useRef<HTMLDivElement>(null);
  const searchAnchorRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const deferredSearch = useDeferredValue(searchQuery.trim());

  const loadSystemStatus = useSystemStore(s => s.loadStatus);
  const showStatusBar = usePlaybackStore(s => Boolean(s.active && s.media));

  const libraries = useLibraryStore(s => s.libraries);
  const selectedLibrary = useLibraryStore(s => s.selectedLibrary);
  const selectedShow = useLibraryStore(s => s.selectedShow);
  const selectedSeason = useLibraryStore(s => s.selectedSeason);
  const selectedEpisodeId = useLibraryStore(s => s.selectedEpisodeId);
  const selectedMovieId = useLibraryStore(s => s.selectedMovieId);
  const selectLibrary = useLibraryStore(s => s.selectLibrary);
  const selectShow = useLibraryStore(s => s.selectShow);
  const selectMovie = useLibraryStore(s => s.selectMovie);
  const selectAllLibraries = useLibraryStore(s => s.selectAllLibraries);

  useEffect(() => {
    void restoreFromHash();
  }, []);

  useEffect(() => {
    void loadSystemStatus();
    const interval = setInterval(() => { void loadSystemStatus(); }, 30000);
    return () => clearInterval(interval);
  }, [loadSystemStatus]);

  useEffect(() => {
    if (isMobile && (selectedEpisodeId || selectedMovieId)) {
      setSidebarOpen(false);
    }
  }, [isMobile, selectedEpisodeId, selectedMovieId]);

  useEffect(() => {
    if (!deferredSearch) {
      setSearchExpanded(false);
      setSearchDropdownOpen(false);
      setSearchResults([]);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }

    if (searchExpanded) {
      setSearchDropdownOpen(false);
      return;
    }

    let cancelled = false;
    setSearchDropdownOpen(true);

    const timeout = window.setTimeout(() => {
      setSearchLoading(true);
      setSearchError(null);

      api.searchLibraries(deferredSearch)
        .then(results => {
          if (!cancelled) {
            setSearchResults(results);
          }
        })
        .catch(err => {
          if (!cancelled) {
            setSearchResults([]);
            setSearchError(err instanceof Error ? err.message : 'Failed to search');
          }
        })
        .finally(() => {
          if (!cancelled) {
            setSearchLoading(false);
          }
        });
    }, 140);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [deferredSearch, searchExpanded]);

  useEffect(() => {
    if (!searchDropdownOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (searchAnchorRef.current?.contains(target)) return;
      setSearchDropdownOpen(false);
    };

    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [searchDropdownOpen]);

  const setSearchQuery = useCallback((query: string) => {
    storeSetSearchQuery(query);
  }, [storeSetSearchQuery]);

  const setSearchExpanded = useCallback((expanded: boolean) => {
    storeSetSearchExpanded(expanded);
    if (!expanded) setSearchDropdownOpen(false);
  }, [storeSetSearchExpanded]);

  const resetSearch = useCallback(() => {
    storeResetSearch();
    setSearchDropdownOpen(false);
  }, [storeResetSearch]);

  const handleOpenSearchResult = useCallback(async (result: LibrarySearchResult) => {
    const library = libraries.find(entry => entry.id === result.libraryId) ?? buildLibraryFromResult(result);

    if (selectedLibrary?.id !== library.id) {
      await selectLibrary(library);
    }

    resetSearch();

    if (result.kind === 'show') {
      await selectShow(buildShowFromResult(result));
      return;
    }

    selectMovie(result.id);
  }, [libraries, resetSearch, selectLibrary, selectMovie, selectShow, selectedLibrary?.id]);

  const handleExpandSearch = useCallback(() => {
    if (!deferredSearch) return;
    setSearchExpanded(true);
    setSearchDropdownOpen(false);
  }, [deferredSearch]);

  const handleSidebarResizeDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setSidebarResizing(true);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const handleSidebarResizeMove = useCallback((e: React.PointerEvent) => {
    if (!sidebarResizing || !layoutRef.current) return;
    const rect = layoutRef.current.getBoundingClientRect();
    const newWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, e.clientX - rect.left));
    setSidebarWidth(Math.round(newWidth));
  }, [sidebarResizing]);

  const handleSidebarResizeUp = useCallback(() => {
    setSidebarResizing(false);
  }, []);

  const searchPlaceholder = selectedEpisodeId || selectedMovieId
    ? 'Search another movie or show'
    : 'Search movies, shows, and libraries';
  const editorVisible = !searchExpanded && Boolean(selectedEpisodeId || selectedMovieId);
  const mobileDockInset = showStatusBar ? 'var(--dock-height)' : '0px';

  // Generate aurora background colors based on current navigation context.
  // Derives unique hues from a seed string (item name/id) so each item gets its own aurora.
  const auroraStyle = useMemo((): React.CSSProperties => {
    let seed: string | null = null;
    if (selectedEpisodeId || selectedMovieId) {
      seed = `item-${selectedEpisodeId || selectedMovieId}`;
    } else if (selectedSeason) {
      seed = `season-${selectedSeason.id}`;
    } else if (selectedShow) {
      seed = `show-${selectedShow.id}`;
    } else if (selectedLibrary) {
      seed = `lib-${selectedLibrary.id}`;
    }

    if (!seed) return { background: '#1e2023' };

    // Simple hash to derive deterministic hue values from the seed
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    }
    const h1 = ((hash & 0xff) / 255) * 360;
    const h2 = (((hash >> 8) & 0xff) / 255) * 360;
    const h3 = (((hash >> 16) & 0xff) / 255) * 360;

    return {
      background: [
        `radial-gradient(circle farthest-side at 0% 100%, hsla(${h1}, 40%, 12%, 0.8) 0%, transparent 100%)`,
        `radial-gradient(circle farthest-side at 100% 0%, hsla(${h2}, 35%, 10%, 0.7) 0%, transparent 100%)`,
        `radial-gradient(circle farthest-side at 80% 100%, hsla(${h3}, 30%, 8%, 0.5) 0%, transparent 100%)`,
        '#1e2023',
      ].join(', '),
    };
  }, [selectedLibrary, selectedShow, selectedSeason, selectedEpisodeId, selectedMovieId]);

  return (
    <>
      <div className="plex-aurora-bg" style={auroraStyle} />
      <div className="h-screen flex flex-col text-[var(--color-text-default)] relative z-[1]">
      <header className="plex-topbar shrink-0">
        <div className="plex-topbar-inner">
          <div className="plex-topbar-leading">
            <button
              onClick={() => {
                if (isMobile) {
                  setSidebarOpen(o => !o);
                } else {
                  setSidebarCollapsed(c => !c);
                  setSidebarHovered(false);
                }
              }}
              className="plex-icon-button shrink-0"
              title={sidebarCollapsed ? 'Expand navigation' : 'Collapse navigation'}
            >
              <MenuIcon />
            </button>

            <a
              href="#"
              onClick={e => handleNavClick(e, () => {
                selectAllLibraries();
                resetSearch();
              })}
              className="shrink-0 flex items-center gap-2 text-left cursor-pointer"
              title="Go home"
            >
              <svg aria-hidden="true" height="28" viewBox="0 0 72 28" fill="currentColor" xmlns="http://www.w3.org/2000/svg" className="text-white">
                <text x="0" y="22" fontFamily="'Open Sans', sans-serif" fontWeight="700" fontSize="22" letterSpacing="1" fill="white">P</text>
                <text x="17" y="22" fontFamily="'Open Sans', sans-serif" fontWeight="700" fontSize="22" letterSpacing="1" fill="#e5a00d">M</text>
                <text x="42" y="22" fontFamily="'Open Sans', sans-serif" fontWeight="700" fontSize="22" letterSpacing="1" fill="white">E</text>
              </svg>
            </a>
          </div>

          <div ref={searchAnchorRef} className="plex-topbar-search-slot plex-search-anchor">
            <label className="plex-topbar-search">
              <span className="plex-search-icon shrink-0">
                <SearchIcon />
              </span>
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onFocus={() => {
                  if (deferredSearch && !searchExpanded) {
                    setSearchDropdownOpen(true);
                  }
                }}
                onKeyDown={event => {
                  if (event.key === 'Enter' && deferredSearch) {
                    event.preventDefault();
                    handleExpandSearch();
                  }

                  if (event.key === 'Escape') {
                    if (searchExpanded) {
                      resetSearch();
                    } else {
                      setSearchDropdownOpen(false);
                    }
                  }
                }}
                placeholder={searchPlaceholder}
                aria-label="Search"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={resetSearch}
                  className="plex-search-clear shrink-0"
                  title="Clear search"
                >
                  <CloseIcon />
                </button>
              )}
            </label>

            {Boolean(deferredSearch && searchDropdownOpen && !searchExpanded) && (
              <div className="plex-search-dropdown animate-fade-in">
                <div className="plex-search-dropdown-header">
                  <div className="plex-search-dropdown-kicker">Search</div>
                  <h2 className="plex-search-dropdown-heading">Top Results for "{deferredSearch}"</h2>
                </div>

                <div className="plex-search-dropdown-results">
                  {searchLoading && searchResults.length === 0 ? (
                    <div className="plex-search-dropdown-empty">Searching Plex libraries…</div>
                  ) : searchError ? (
                    <div className="plex-search-dropdown-empty plex-search-dropdown-empty-error">{searchError}</div>
                  ) : searchResults.length > 0 ? (
                    <>
                      <div className="plex-search-dropdown-list">
                        {searchResults.slice(0, 8).map(result => (
                          <SearchDropdownRow
                            key={`${result.kind}-${result.id}`}
                            result={result}
                            href={buildNavHash(result.kind === 'show'
                              ? { libraryId: result.libraryId, showId: result.id }
                              : { libraryId: result.libraryId, movieId: result.id })}
                            onOpen={() => { void handleOpenSearchResult(result); }}
                          />
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="plex-search-dropdown-empty">
                      No titles matched "{deferredSearch}".
                    </div>
                  )}
                </div>

                {searchResults.length > 8 && (
                  <div className="plex-search-dropdown-footer">
                    <button type="button" onClick={handleExpandSearch} className="plex-search-more-button">
                      View More Results
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="plex-topbar-actions">
            <button
              onClick={() => setShowSettings(true)}
              className="plex-icon-button shrink-0"
              title="Settings"
            >
              <SettingsIcon />
            </button>

            <div className="relative flex items-center">
              <button
                onClick={() => setProfileMenuOpen(!profileMenuOpen)}
                className="plex-topbar-home hidden sm:flex"
                title={user?.username || 'Account'}
              >
                {user?.thumb ? (
                  <img src={user.thumb} alt={user.username || 'User'} className="w-full h-full object-cover rounded-full" />
                ) : (
                  <span className="font-[var(--font-display)] text-[11px] font-bold tracking-[0.18em] pl-[0.18em]">
                    {user?.username ? user.username.charAt(0).toUpperCase() : 'PME'}
                  </span>
                )}
              </button>
              <button
                onClick={() => setProfileMenuOpen(!profileMenuOpen)}
                className="hidden sm:flex items-center justify-center w-4 h-8 text-white/50 hover:text-white transition-colors"
                aria-label="Toggle menu"
              >
                <svg width="10" height="6" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
              {profileMenuOpen && (
                <>
                  <div className="fixed inset-0 z-[99]" onClick={() => setProfileMenuOpen(false)} />
                  <div className="absolute right-0 top-full mt-2 z-[100] plex-profile-menu">
                    <div className="plex-profile-menu-header">
                      <div className="plex-profile-menu-avatar">
                        {user?.thumb ? <img src={user.thumb} className="w-full h-full object-cover" alt="" /> : (
                          <span className="flex items-center justify-center w-full h-full text-2xl font-bold text-white bg-white/10">
                            {user?.username ? user.username.charAt(0).toUpperCase() : '?'}
                          </span>
                        )}
                      </div>
                      <div className="plex-profile-menu-name">{user?.username || 'User'}</div>
                      <div className="plex-profile-menu-handle">{user?.email || ''}</div>
                    </div>
                    <div className="plex-profile-menu-divider" />
                    <button onClick={() => { setProfileMenuOpen(false); setShowSettings(true); }} className="plex-profile-menu-item">
                      Settings
                    </button>
                    <div className="plex-profile-menu-divider" />
                    <button onClick={() => { setProfileMenuOpen(false); void logout(); }} className="plex-profile-menu-item">
                      Sign Out
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      <div
        ref={layoutRef}
        className={`flex-1 flex min-h-0 overflow-hidden relative plex-shell-pane ${sidebarResizing ? 'select-none' : ''}`}
      >
        {isMobile ? (
          <>
            {sidebarOpen && (
              <div
                className="fixed inset-x-0 z-40 bg-black/60 sidebar-backdrop-enter"
                onClick={() => setSidebarOpen(false)}
                style={{ top: 'var(--topbar-total-height)', bottom: mobileDockInset }}
              />
            )}
            <div
              className={`fixed left-0 z-50 w-[82vw] max-w-[320px] bg-[#1a1c1e] transition-transform duration-250 ease-out ${
                sidebarOpen ? 'translate-x-0 sidebar-drawer-enter' : '-translate-x-full'
              }`}
              style={{ top: 'var(--topbar-total-height)', bottom: mobileDockInset }}
            >
              <Sidebar style={{ width: '100%', height: '100%' }} />
            </div>
          </>
        ) : (
          <>
            <div
              className="plex-sidebar-shell"
              style={{ width: sidebarCollapsed && !sidebarHovered ? COLLAPSED_SIDEBAR_WIDTH : sidebarWidth, transition: 'width 0.2s ease' }}
              onMouseEnter={() => { if (sidebarCollapsed) setSidebarHovered(true); }}
              onMouseLeave={() => { if (sidebarCollapsed) setSidebarHovered(false); }}
            >
              <Sidebar collapsed={sidebarCollapsed && !sidebarHovered} style={{ width: '100%', height: '100%' }} />
            </div>
            {!sidebarCollapsed && (
            <div
              className={`plex-sidebar-resize shrink-0 w-1.5 cursor-col-resize group relative ${
                sidebarResizing ? 'bg-[rgba(229,160,13,0.14)]' : 'bg-transparent hover:bg-white/4'
              } transition-colors`}
              onPointerDown={handleSidebarResizeDown}
              onPointerMove={handleSidebarResizeMove}
              onPointerUp={handleSidebarResizeUp}
              onPointerCancel={handleSidebarResizeUp}
              onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
              title="Resize navigation"
            >
              <div className={`absolute inset-y-0 left-1/2 -translate-x-1/2 w-px my-auto h-10 rounded-full transition-colors ${
                sidebarResizing ? 'bg-[var(--color-accent)]' : 'bg-transparent group-hover:bg-white/12'
              }`} />
            </div>
            )}
          </>
        )}

        <MainContent
          searchQuery={searchQuery}
          searchExpanded={searchExpanded}
          onResetSearch={resetSearch}
        />
      </div>

      {showStatusBar && <StatusBar onPreparePlaybackNavigation={resetSearch} editorVisible={editorVisible} />}
      <SettingsDialog open={showSettings} onClose={() => setShowSettings(false)} />
    </div>
    </>
  );
}
