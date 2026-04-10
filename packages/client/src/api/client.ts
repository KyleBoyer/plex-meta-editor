import type { ApiResponse } from '@plex-meta-editor/shared';

export interface MarkerSummaryEntry {
  type: string;
  start: number;
  end: number;
}

export type ArtworkKind = 'thumb' | 'art';

const API_BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options,
  });

  // If the session has expired or is missing, reload to show login screen
  if (res.status === 401) {
    // Avoid redirect loops for auth endpoints themselves
    if (!path.startsWith('/auth/')) {
      window.location.reload();
      throw new Error('Session expired');
    }
  }

  const json = (await res.json()) as ApiResponse<T>;

  if (!json.success) {
    throw new Error(json.error || 'Unknown API error');
  }

  return json.data as T;
}

function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
}

function put<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined });
}

function del<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' });
}

function buildPlexTranscodeUrl(
  metadataId: number,
  variant: 'standard' | 'full' | 'safe',
  sessionId?: string,
): string {
  const params = new URLSearchParams({ variant });
  if (sessionId) {
    params.set('session', sessionId);
  }

  return `/api/media/plex-transcode/${metadataId}/start.m3u8?${params.toString()}`;
}

// ── API Client ──────────────────────────────────────────────────

import type {
  Library, Show, Season, Episode, Movie,
  Marker, EpisodeWithMarkers, MovieWithMarkers,
  NewMarker, UpdateMarker, MarkerType, MediaInfo, SessionStatus, WriteHistoryEntry,
  BackupInfo, BulkPreviewResult, ChapterData, DbCheckResult, SystemStatus,
  LibrarySearchResult, AllowedUsersData, PlexHomeUser, PlexUserValidation,
} from '@plex-meta-editor/shared';

export const api = {
  // Libraries
  getLibraries: () => get<Library[]>('/libraries'),
  searchLibraries: (query: string, libraryId?: number) => {
    const params = new URLSearchParams({ q: query });
    if (libraryId) params.set('libraryId', String(libraryId));
    return get<LibrarySearchResult[]>(`/libraries/search?${params.toString()}`);
  },
  getShows: (libraryId: number) => get<Show[]>(`/libraries/${libraryId}/shows`),
  getMovies: (libraryId: number) => get<Movie[]>(`/libraries/${libraryId}/movies`),

  // Shows / Seasons / Episodes
  getSeasons: (showId: number) => get<Season[]>(`/shows/${showId}/seasons`),
  getEpisodesBySeason: (seasonId: number) => get<Episode[]>(`/episodes/season/${seasonId}`),
  getEpisode: (id: number) => get<EpisodeWithMarkers>(`/episodes/${id}`),
  getMovie: (id: number) => get<MovieWithMarkers>(`/movies/${id}`),
  updateEpisodeDuration: (id: number, duration: number) => put<{ id: number; duration: number }>(`/episodes/${id}/duration`, { duration }),

  // Markers
  getMarkers: (metadataId: number) => get<Marker[]>(`/markers/${metadataId}`),
  addMarker: (marker: NewMarker) => post<Marker>('/markers', marker),
  editMarker: (id: number, update: { type: MarkerType; start: number; end: number; isFinal: boolean }) => put<Marker>(`/markers/${id}`, update),
  deleteMarker: (id: number) => del<Marker>(`/markers/${id}`),
  getSeasonMarkerSummary: (seasonId: number) => get<Record<string, MarkerSummaryEntry[]>>(`/markers/summary/season/${seasonId}`),
  getLibraryMarkerSummary: (libraryId: number) => get<Record<string, MarkerSummaryEntry[]>>(`/markers/summary/library/${libraryId}`),

  // Media
  getMediaInfo: (metadataId: number) => get<MediaInfo & { fileExists: boolean }>(`/media/info/${metadataId}`),

  // Chapters
  getChapters: (metadataId: number) => get<ChapterData>(`/chapters/${metadataId}`),
  getSeasonChapterSummary: (seasonId: number) => get<Record<string, number[]>>(`/chapters/summary/season/${seasonId}`),
  getLibraryChapterSummary: (libraryId: number) => get<Record<string, number[]>>(`/chapters/summary/library/${libraryId}`),
  setChapters: (metadataId: number, chapters: { name: string; start: number; end: number }[]) =>
    put<ChapterData>(`/chapters/${metadataId}`, { chapters }),
  clearChapters: (metadataId: number) => del<void>(`/chapters/${metadataId}`),

  /** Build the video stream URL for a given metadata ID */
  getDirectStreamUrl: (metadataId: number) => `/api/media/stream/${metadataId}`,

  /** Build the Plex proxy stream URL */
  getPlexStreamUrl: (metadataId: number) => `/api/media/plex-stream/${metadataId}`,

  /** Build a proxied Plex artwork URL for posters or background art. */
  getArtworkUrl: (metadataId: number, kind: ArtworkKind = 'thumb') =>
    `/api/media/artwork/${metadataId}/${kind}`,

  /** Build the default Plex HLS playback URL.
   *  Returns an M3U8 URL proxied through the editor server. */
  getPlexTranscodeUrl: (metadataId: number, sessionId?: string) =>
    buildPlexTranscodeUrl(metadataId, 'standard', sessionId),

  /** Build a Plex HLS URL that forces full video+audio transcode under a
   *  multichannel-capable client profile. This avoids broken AAC audio-copy
   *  TS segments while preserving 5.1 when Plex can transcode it cleanly. */
  getPlexFullTranscodeUrl: (metadataId: number, sessionId?: string) =>
    buildPlexTranscodeUrl(metadataId, 'full', sessionId),

  /** Build a safer Plex HLS transcode URL that downmixes audio to stereo AAC.
   *  Some Plex HLS sessions copy 5.1 AAC into TS with malformed timestamps;
   *  asking for stereo forces Plex onto a cleaner audio transcode path. */
  getPlexSafeTranscodeUrl: (metadataId: number, sessionId?: string) =>
    buildPlexTranscodeUrl(metadataId, 'safe', sessionId),

  /** Build the BIF (Base Index Frames) thumbnail proxy URL. */
  getBifUrl: (metadataId: number) => `/api/media/bif/${metadataId}`,

  /** Fetch the raw BIF binary for a media item. Returns null if unavailable. */
  fetchBif: async (metadataId: number, signal?: AbortSignal): Promise<ArrayBuffer | null> => {
    try {
      const res = await fetch(`${API_BASE}/media/bif/${metadataId}`, {
        credentials: 'include',
        signal,
      });
      if (res.status === 401) {
        window.location.reload();
        throw new Error('Session expired');
      }
      if (!res.ok) return null;
      return await res.arrayBuffer();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      return null;
    }
  },

  // Bulk Operations
  bulkAddPreview: (params: { metadataId: number; type: string; start: number; end: number; ignoredEpisodes?: number[] }) =>
    post<BulkPreviewResult & { skipped: number; totalEpisodes: number }>('/bulk/add/preview', params),
  bulkAddCommit: (params: { metadataId: number; type: string; start: number; end: number; ignoredEpisodes?: number[] }) =>
    post<{ markersAffected: number; skipped: number }>('/bulk/add/commit', params),
  bulkDeletePreview: (params: { metadataId: number; markerType?: string; ignoredMarkerIds?: number[] }) =>
    post<BulkPreviewResult>('/bulk/delete/preview', params),
  bulkDeleteCommit: (params: { metadataId: number; markerType?: string; ignoredMarkerIds?: number[] }) =>
    post<{ markersAffected: number }>('/bulk/delete/commit', params),
  bulkShiftPreview: (params: { metadataId: number; startShift: number; endShift: number; markerType?: string; ignoredMarkerIds?: number[] }) =>
    post<BulkPreviewResult>('/bulk/shift/preview', params),
  bulkShiftCommit: (params: { metadataId: number; startShift: number; endShift: number; markerType?: string; ignoredMarkerIds?: number[] }) =>
    post<{ markersAffected: number }>('/bulk/shift/commit', params),

  // Session
  getSession: () => get<SessionStatus>('/session'),
  getWriteHistory: () => get<WriteHistoryEntry[]>('/session/history'),
  checkConflicts: () => post<unknown>('/session/check-conflicts'),

  // System
  getStatus: () => get<SystemStatus>('/status'),
  getBackups: () => get<BackupInfo[]>('/backups'),
  createBackup: () => post<BackupInfo>('/backup'),
  runDbCheck: () => post<DbCheckResult>('/db-check'),

  // Admin — Access Control
  getAllowedUsers: () => get<AllowedUsersData>('/admin/allowed-users'),
  addAllowedUser: (value: string, label?: string, source?: 'manual' | 'plex-home', thumb?: string) =>
    post<AllowedUsersData>('/admin/allowed-users', { value, label, source, thumb }),
  removeAllowedUser: (value: string) =>
    del<AllowedUsersData>(`/admin/allowed-users/${encodeURIComponent(value)}`),
  setPlexHomeAllowed: (allowed: boolean) =>
    put<AllowedUsersData>('/admin/plex-home-allowed', { allowed }),
  getPlexHomeUsers: () => get<PlexHomeUser[]>('/admin/plex-home-users'),
  validatePlexUser: (query: string) =>
    post<PlexUserValidation>('/admin/validate-plex-user', { query }),
};
