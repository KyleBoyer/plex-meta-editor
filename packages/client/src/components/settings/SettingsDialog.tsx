import { useEffect, useState, useCallback } from 'react';
import type { PlexAuthSource, AllowedUserEntry, PlexHomeUser, PlexUserValidation } from '@plex-meta-editor/shared';
import { api } from '../../api/client';
import { useSettingsStore, type PlaybackModeOverride, type OverlayVisibility, type OverlayColors, DEFAULT_OVERLAY_COLORS } from '../../stores/settings';
import { useSystemStore } from '../../stores/system';
import { useAuthStore } from '../../stores/auth';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsDialog({ open, onClose }: Props) {
  const playbackMode = useSettingsStore(s => s.playbackMode);
  const setPlaybackMode = useSettingsStore(s => s.setPlaybackMode);
  const overlayVisibility = useSettingsStore(s => s.overlayVisibility);
  const setOverlayVisibility = useSettingsStore(s => s.setOverlayVisibility);
  const overlayColors = useSettingsStore(s => s.overlayColors);
  const setOverlayColor = useSettingsStore(s => s.setOverlayColor);
  const resetOverlayColors = useSettingsStore(s => s.resetOverlayColors);
  const systemStatus = useSystemStore(s => s.status);
  const systemLoading = useSystemStore(s => s.loading);
  const systemError = useSystemStore(s => s.error);
  const loadStatus = useSystemStore(s => s.loadStatus);
  const user = useAuthStore(s => s.user);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [diagnosticsError, setDiagnosticsError] = useState('');
  const [dbCheckStatus, setDbCheckStatus] = useState<'idle' | 'running'>('idle');

  useEffect(() => {
    if (!open) return;
    void loadStatus();
  }, [open, loadStatus]);

  if (!open) return null;

  const handleRunDbCheck = async () => {
    setDbCheckStatus('running');
    setDiagnosticsError('');
    try {
      await api.runDbCheck();
      await loadStatus();
    } catch (err) {
      setDiagnosticsError(err instanceof Error ? err.message : 'Database check failed');
    } finally {
      setDbCheckStatus('idle');
    }
  };

  const lastCheck = systemStatus?.lastIntegrityCheck;
  const lastCheckSummary = lastCheck
    ? lastCheck.ok
      ? `Passed ${new Date(lastCheck.checkedAt).toLocaleString()}`
      : `Failed ${new Date(lastCheck.checkedAt).toLocaleString()}`
    : 'No full DB check has run yet';

  return (
    <div
      className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-t-lg sm:rounded-lg border border-white/8 bg-[#1c1c1c] shadow-[0_28px_60px_rgba(0,0,0,0.44)] animate-slide-up sm:animate-fade-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 sm:px-5 py-4 border-b border-white/8 sticky top-0 bg-[#1c1c1c] z-10">
          <div className="absolute top-1.5 left-1/2 -translate-x-1/2 w-8 h-1 rounded-full bg-zinc-600 sm:hidden" />
          <h2 className="text-base font-semibold text-white">Settings</h2>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 transition-colors text-lg leading-none p-1 cursor-pointer">&times;</button>
        </div>

        <div className="px-4 sm:px-5 py-4 space-y-5">
          {user?.isOwner && <AccessSettings />}

          <div className="space-y-3">
            <label className="block text-[11px] uppercase tracking-wider text-zinc-400 font-medium mb-2">Marker Overlays</label>
            <div className="rounded-lg border border-white/8 bg-white/5 p-4 space-y-1">
              <p className="text-[11px] text-zinc-500 leading-relaxed mb-3">
                Control which marker types and boundaries are displayed on listing views and the player progress bar.
              </p>
              {([
                ['intro', 'Intro markers'],
                ['commercial', 'Commercial markers'],
                ['credits', 'Credits markers'],
                ['chapterBoundary', 'Chapter boundaries'],
                ['episodeBoundary', 'Episode boundaries'],
              ] as [keyof OverlayVisibility & keyof OverlayColors, string][]).map(([key, label]) => (
                <div key={key} className="flex items-center justify-between gap-3 py-1.5 group">
                  <span className="flex items-center gap-2.5 text-sm text-zinc-300 group-hover:text-white transition-colors">
                    <input
                      type="color"
                      value={overlayColors[key]}
                      onChange={(e) => setOverlayColor(key, e.target.value)}
                      className="w-5 h-5 rounded-sm border border-white/10 cursor-pointer bg-transparent p-0 shrink-0"
                      title={`Change ${label.toLowerCase()} color`}
                      style={{ colorScheme: 'dark' }}
                    />
                    {label}
                  </span>
                  <input
                    type="checkbox"
                    checked={overlayVisibility[key]}
                    onChange={(e) => setOverlayVisibility(key, e.target.checked)}
                    className="w-4 h-4 rounded border-zinc-600 bg-[var(--color-surface-2)] accent-[var(--color-accent)] cursor-pointer"
                  />
                </div>
              ))}
              <div className="pt-2">
                <button
                  onClick={resetOverlayColors}
                  className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                >
                  Reset colors to defaults
                </button>
              </div>
            </div>
          </div>

          <div>
            <label className="block text-[11px] uppercase tracking-wider text-zinc-400 font-medium mb-2">Plex Playback</label>
            <div className="space-y-3">
              <div className="rounded-lg border border-white/8 bg-white/5 p-4 space-y-2">
                <p className="text-[11px] text-zinc-400 leading-relaxed">
                  Plex playback now runs entirely through the editor server. The browser never sees the Plex URL or token, and public editor access can still work while Plex stays private.
                </p>
                <div className="flex items-center justify-between gap-4 text-[11px]">
                  <span className="text-zinc-400">Server-side Plex config</span>
                  <span className={systemStatus?.plexConfigured ? 'text-green-400' : 'text-amber-400'}>
                    {systemStatus?.plexConfigured ? 'Configured' : 'Unavailable'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4 text-[11px]">
                  <span className="text-zinc-400">Startup Plex check</span>
                  <span className={systemStatus?.plexReachable ? 'text-green-400' : 'text-amber-400'}>
                    {systemStatus?.plexReachable ? 'Connected' : 'Failed'}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4 text-[11px]">
                  <span className="text-zinc-400">Token source</span>
                  <span className="text-zinc-200">{describeAuthSource(systemStatus?.plexAuthSource)}</span>
                </div>
                {systemStatus?.plexStartupError && (
                  <div className="text-[11px] text-amber-300 leading-relaxed">
                    {systemStatus.plexStartupError}
                  </div>
                )}
                {!systemStatus?.plexStartupError && systemStatus?.plexReachable && (
                  <div className="text-[11px] text-zinc-500 leading-relaxed">
                    Direct file, Plex API, and Plex transcode playback are all proxied through this app.
                  </div>
                )}
                {systemLoading && (
                  <div className="text-[11px] text-zinc-500">Loading Plex status\u2026</div>
                )}
                {systemError && (
                  <div className="text-[11px] text-red-400 leading-relaxed">{systemError}</div>
                )}
              </div>

              <div>
                <button
                  onClick={() => setAdvancedOpen(o => !o)}
                  className="flex items-center gap-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                >
                  <span className={`text-[10px] transition-transform ${advancedOpen ? 'rotate-90' : ''}`}>&#9654;</span>
                  Advanced
                </button>
                {advancedOpen && (
                  <div className="mt-2 space-y-2">
                    <p className="text-[11px] text-zinc-500">
                      Force a specific playback mode. <strong className="text-zinc-400">Plex Transcode</strong> keeps the UI simple and internally tries Full, then Safe, then Standard HLS transcode paths.
                    </p>
                    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                      {([
                        ['auto',           'Auto'],
                        ['direct',         'Direct File'],
                        ['plex-api',       'Plex API'],
                        ['plex-transcode', 'Plex Transcode'],
                      ] as [PlaybackModeOverride, string][]).map(([value, label]) => (
                        <button
                          key={value}
                          onClick={() => setPlaybackMode(value)}
                          className={`px-2 py-2 rounded text-[11px] font-medium border transition-all cursor-pointer ${
                            playbackMode === value
                              ? 'bg-[var(--color-accent)]/14 border-[var(--color-accent)]/40 text-[var(--color-accent)]'
                              : 'bg-white/6 border-white/8 text-zinc-300 hover:border-white/14'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-zinc-400 font-medium mb-2">Database Diagnostics</label>
              <div className="rounded-lg border border-white/8 bg-white/5 p-4 space-y-2">
                <div className="flex items-center justify-between gap-4 text-[11px]">
                  <span className="text-zinc-400">Write mode</span>
                  <span className="font-mono text-zinc-200">{systemStatus?.writeMode || 'hybrid-writes'}</span>
                </div>
                <div className="flex items-center justify-between gap-4 text-[11px]">
                  <span className="text-zinc-400">Plex SQLite</span>
                  <span className={systemStatus?.plexSqliteAvailable ? 'text-green-400' : 'text-amber-400'}>
                    {systemStatus?.plexSqliteAvailable ? 'Available' : 'Unavailable'}
                  </span>
                </div>
                <div className="text-[11px] text-zinc-400 leading-relaxed">
                  <span className="text-zinc-300 font-medium">Binary:</span>{' '}
                  <span className="font-mono break-all">{systemStatus?.plexSqlitePath || 'Not discovered'}</span>
                </div>
                <div className="text-[11px] text-zinc-400 leading-relaxed">
                  <span className="text-zinc-300 font-medium">Last full DB check:</span>{' '}
                  <span className={lastCheck?.ok === false ? 'text-red-400' : 'text-zinc-300'}>{lastCheckSummary}</span>
                </div>
                {lastCheck && (
                  <div className="text-[11px] text-zinc-500 leading-relaxed">
                    Duration: {(lastCheck.durationMs / 1000).toFixed(2)}s via {lastCheck.checker}
                    {lastCheck.issues.length > 0 ? ` \u2022 ${lastCheck.issues.join('; ')}` : ''}
                  </div>
                )}
                {systemStatus?.plexSqliteStartupError && (
                  <div className="text-[11px] text-amber-300 leading-relaxed">
                    {systemStatus.plexSqliteStartupError}
                  </div>
                )}
                {diagnosticsError && (
                  <div className="text-[11px] text-red-400 leading-relaxed">{diagnosticsError}</div>
                )}
                <div className="flex items-center gap-3 pt-1 flex-wrap">
                  <button
                    onClick={handleRunDbCheck}
                    disabled={dbCheckStatus === 'running' || systemLoading || !systemStatus?.plexSqliteAvailable}
                    className="ctrl-btn text-xs px-4 py-2 sm:py-1.5 disabled:opacity-40"
                  >
                    {dbCheckStatus === 'running' ? 'Running Check\u2026' : 'Run Full DB Check'}
                  </button>
                  <span className="text-[11px] text-zinc-500">
                    Uses Plex&apos;s official SQLite binary against the full database file.
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="px-4 sm:px-5 py-4 border-t border-white/8 flex justify-end sticky bottom-0 bg-[#1c1c1c]">
          <button onClick={onClose} className="ctrl-btn ctrl-btn-accent text-xs px-5 py-2 sm:py-1.5">Done</button>
        </div>
      </div>
    </div>
  );
}

function UserAvatar({ thumb, name, size = 5 }: { thumb?: string; name: string; size?: number }) {
  if (thumb) {
    return (
      <img
        src={thumb}
        alt=""
        className={`w-${size} h-${size} rounded-full object-cover shrink-0`}
        style={{ width: `${size * 4}px`, height: `${size * 4}px` }}
      />
    );
  }
  return (
    <div
      className="rounded-full bg-white/10 flex items-center justify-center text-[10px] font-bold text-white shrink-0"
      style={{ width: `${size * 4}px`, height: `${size * 4}px` }}
    >
      {(name || '?').charAt(0).toUpperCase()}
    </div>
  );
}

function AccessSettings() {
  const [allowedUsers, setAllowedUsers] = useState<AllowedUserEntry[]>([]);
  const [plexHomeAllowed, setPlexHomeAllowedState] = useState(false);
  const [homeUsers, setHomeUsers] = useState<PlexHomeUser[]>([]);
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeError, setHomeError] = useState('');
  const [manualInput, setManualInput] = useState('');
  const [validation, setValidation] = useState<PlexUserValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const applyData = useCallback((data: { entries: AllowedUserEntry[]; plexHomeAllowed: boolean }) => {
    setAllowedUsers(data.entries);
    setPlexHomeAllowedState(data.plexHomeAllowed);
  }, []);

  const loadData = useCallback(async () => {
    try {
      const data = await api.getAllowedUsers();
      applyData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load allowed users');
    }

    setHomeLoading(true);
    setHomeError('');
    try {
      const users = await api.getPlexHomeUsers();
      setHomeUsers(users);
    } catch (err) {
      setHomeError(err instanceof Error ? err.message : 'Failed to fetch Plex Home users');
    } finally {
      setHomeLoading(false);
    }
  }, [applyData]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Debounced validation when manual input changes
  useEffect(() => {
    const trimmed = manualInput.trim();
    if (!trimmed) {
      setValidation(null);
      return;
    }

    setValidating(true);
    const timeout = window.setTimeout(() => {
      api.validatePlexUser(trimmed)
        .then((result) => setValidation(result))
        .catch(() => setValidation(null))
        .finally(() => setValidating(false));
    }, 400);

    return () => {
      window.clearTimeout(timeout);
      setValidating(false);
    };
  }, [manualInput]);

  const isAllowed = (username: string, email: string): boolean => {
    const uLower = username.toLowerCase();
    const eLower = email.toLowerCase();
    return allowedUsers.some(
      (e) => e.value === uLower || e.value === eLower,
    );
  };

  const handleTogglePlexHome = async () => {
    setSaving(true);
    setError('');
    try {
      const data = await api.setPlexHomeAllowed(!plexHomeAllowed);
      applyData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleHomeUser = async (user: PlexHomeUser) => {
    setSaving(true);
    setError('');
    try {
      const identifier = user.username || user.email;
      if (isAllowed(user.username, user.email)) {
        // Remove — try both username and email
        let data = await api.removeAllowedUser(user.username.toLowerCase());
        if (user.email) {
          data = await api.removeAllowedUser(user.email.toLowerCase());
        }
        applyData(data);
      } else {
        const data = await api.addAllowedUser(
          identifier,
          user.username || user.email,
          'plex-home',
          user.thumb,
        );
        applyData(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const handleAddManual = async () => {
    const value = manualInput.trim();
    if (!value) return;

    setSaving(true);
    setError('');
    try {
      // Use validation result if available for richer data
      const label = validation?.found ? (validation.username || validation.email || '') : '';
      const thumb = validation?.found ? validation.thumb : undefined;
      const data = await api.addAllowedUser(value, label, 'manual', thumb);
      applyData(data);
      setManualInput('');
      setValidation(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add user');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (entry: AllowedUserEntry) => {
    setSaving(true);
    setError('');
    try {
      const data = await api.removeAllowedUser(entry.value);
      applyData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove user');
    } finally {
      setSaving(false);
    }
  };

  // Separate Plex Home users from manually-added entries for display
  const homeUserValues = new Set(
    homeUsers.flatMap((u) => [u.username.toLowerCase(), u.email.toLowerCase()].filter(Boolean)),
  );
  const manualEntries = allowedUsers.filter((e) => !homeUserValues.has(e.value));

  return (
    <div className="space-y-3">
      <label className="block text-[11px] uppercase tracking-wider text-zinc-400 font-medium mb-2">Access Control</label>
      <div className="rounded-lg border border-white/8 bg-white/5 p-4 space-y-4">
        <p className="text-[11px] text-zinc-500 leading-relaxed">
          Grant other Plex users access to this editor. As the server owner, you always have access.
        </p>

        {/* ── Plex Home master toggle ────────────────────────── */}
        <label className="flex items-center gap-2.5 cursor-pointer group">
          <input
            type="checkbox"
            checked={plexHomeAllowed}
            onChange={() => { void handleTogglePlexHome(); }}
            disabled={saving}
            className="w-4 h-4 rounded border-zinc-600 bg-[var(--color-surface-2)] accent-[var(--color-accent)] cursor-pointer shrink-0"
          />
          <span className="text-sm text-zinc-200 group-hover:text-white transition-colors font-medium">
            Include all Plex Home users
          </span>
        </label>

        {/* ── Individual Plex Home Users ─────────────────────── */}
        {homeUsers.length > 0 && (
          <div className="space-y-1 pl-1">
            <div className="text-[11px] text-zinc-500 font-medium mb-1">
              {plexHomeAllowed ? 'Plex Home Users (all included)' : 'Plex Home Users'}
            </div>
            {homeUsers.map((hu) => {
              const checked = plexHomeAllowed || isAllowed(hu.username, hu.email);
              const displayName = hu.friendlyName || hu.username || hu.email;
              return (
                <label
                  key={hu.id}
                  className={`flex items-center gap-2.5 py-1 group cursor-pointer ${
                    plexHomeAllowed ? 'opacity-50 pointer-events-none' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => { void handleToggleHomeUser(hu); }}
                    disabled={saving || plexHomeAllowed}
                    className="w-3.5 h-3.5 rounded border-zinc-600 bg-[var(--color-surface-2)] accent-[var(--color-accent)] cursor-pointer shrink-0"
                  />
                  <UserAvatar thumb={hu.thumb} name={displayName} size={5} />
                  <span className="text-[13px] text-zinc-300 group-hover:text-white transition-colors truncate">
                    {displayName}
                  </span>
                  {hu.username && displayName !== hu.username && (
                    <span className="text-[10px] text-zinc-600 truncate hidden sm:inline">{hu.username}</span>
                  )}
                </label>
              );
            })}
          </div>
        )}

        {homeLoading && (
          <div className="text-[11px] text-zinc-500">Loading Plex Home users...</div>
        )}
        {homeError && (
          <div className="text-[11px] text-amber-400">{homeError}</div>
        )}

        {/* ── Divider ────────────────────────────────────────── */}
        <div className="border-t border-white/6" />

        {/* ── Manually-added users list ──────────────────────── */}
        {manualEntries.length > 0 && (
          <div className="space-y-1">
            <div className="text-[11px] text-zinc-500 font-medium mb-1">Additional Users</div>
            {manualEntries.map((entry) => (
              <div key={entry.value} className="flex items-center gap-2.5 py-1 group">
                <UserAvatar thumb={entry.thumb} name={entry.label || entry.value} size={5} />
                <span className="text-[13px] text-zinc-300 truncate flex-1">{entry.label || entry.value}</span>
                {entry.label && entry.label !== entry.value && (
                  <span className="text-[10px] text-zinc-600 truncate hidden sm:inline">{entry.value}</span>
                )}
                <button
                  onClick={() => { void handleRemove(entry); }}
                  disabled={saving}
                  className="text-zinc-600 hover:text-red-400 transition-colors text-sm leading-none shrink-0 cursor-pointer disabled:opacity-40 px-1"
                  title={`Remove ${entry.value}`}
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ── Add by username / email ────────────────────────── */}
        <div className="space-y-1.5">
          <div className="text-[11px] text-zinc-500 font-medium">Add by username or email</div>
          <div className="flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <input
                type="text"
                value={manualInput}
                onChange={(e) => setManualInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleAddManual();
                  }
                }}
                placeholder="Plex username or email address"
                className="w-full text-xs px-2.5 py-1.5 rounded border border-white/10 bg-white/5 text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-[var(--color-accent)]/50 transition-colors pr-8"
              />
              {/* Validation indicator */}
              {manualInput.trim() && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center">
                  {validating ? (
                    <svg className="animate-spin w-3.5 h-3.5 text-zinc-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                    </svg>
                  ) : validation?.found ? (
                    <svg className="w-3.5 h-3.5 text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 13l4 4L19 7" />
                    </svg>
                  ) : validation && !validation.found ? (
                    <svg className="w-3.5 h-3.5 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 9v4M12 17h.01" />
                      <circle cx="12" cy="12" r="9" />
                    </svg>
                  ) : null}
                </span>
              )}
            </div>
            <button
              onClick={() => { void handleAddManual(); }}
              disabled={saving || !manualInput.trim()}
              className="ctrl-btn text-xs px-3 py-1.5 disabled:opacity-40 shrink-0"
            >
              Add
            </button>
          </div>
          {/* Validation result preview */}
          {manualInput.trim() && validation?.found && validation.username && (
            <div className="flex items-center gap-2 text-[11px] text-zinc-400 pl-0.5">
              <UserAvatar thumb={validation.thumb} name={validation.username || manualInput} size={4} />
              <span className="text-zinc-300">{validation.username}</span>
              {validation.email && validation.username && (
                <span className="text-zinc-600">{validation.email}</span>
              )}
            </div>
          )}
          {manualInput.trim() && validation?.found && !validation.username && (
            <div className="flex items-center gap-1.5 text-[11px] text-green-400/80 pl-0.5">
              <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 13l4 4L19 7" />
              </svg>
              Valid Plex account
            </div>
          )}
          {manualInput.trim() && validation && !validation.found && !validating && (
            <div className="flex items-center gap-1.5 text-[11px] text-red-400/80 pl-0.5">
              <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
              No Plex account found with this username or email
            </div>
          )}
        </div>

        {error && (
          <div className="text-[11px] text-red-400">{error}</div>
        )}
      </div>
    </div>
  );
}

function describeAuthSource(source: PlexAuthSource | null | undefined): string {
  switch (source) {
    case 'env':
      return 'Server environment';
    case 'macos-plist':
      return 'macOS Plex preferences';
    case 'windows-registry':
      return 'Windows Plex registry';
    case 'preferences-xml':
      return 'Plex Preferences.xml';
    default:
      return 'Not available';
  }
}
