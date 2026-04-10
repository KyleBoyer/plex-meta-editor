// API request/response types

import type {
  Library, Show, Season, Episode, Movie,
  Marker, EpisodeWithMarkers, MovieWithMarkers,
  NewMarker, UpdateMarker, MediaInfo, ChapterData, LibrarySearchResult,
} from './plex.js';
import type { ConflictInfo, DbCheckResult, WriteHistoryEntry } from './safety.js';

// ── Generic API Response ──────────────────────────────────────────

export interface ApiResponse<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

// ── Library Browsing ──────────────────────────────────────────────

export type GetLibrariesResponse = ApiResponse<Library[]>;
export type GetShowsResponse = ApiResponse<Show[]>;
export type GetSeasonsResponse = ApiResponse<Season[]>;
export type GetEpisodesResponse = ApiResponse<Episode[]>;
export type GetMoviesResponse = ApiResponse<Movie[]>;
export type GetLibrarySearchResponse = ApiResponse<LibrarySearchResult[]>;
export type GetEpisodeResponse = ApiResponse<EpisodeWithMarkers>;
export type GetMovieResponse = ApiResponse<MovieWithMarkers>;

// ── Markers ───────────────────────────────────────────────────────

export type GetMarkersResponse = ApiResponse<Marker[]>;

export interface AddMarkerRequest extends NewMarker {}
export type AddMarkerResponse = ApiResponse<Marker>;

export interface EditMarkerRequest extends UpdateMarker {}
export type EditMarkerResponse = ApiResponse<Marker>;

export type DeleteMarkerResponse = ApiResponse<Marker>;

// ── Bulk Operations ───────────────────────────────────────────────

export interface BulkAddRequest {
  /** Show or season metadata ID — adds markers to all episodes underneath */
  metadataId: number;
  type: string;
  start: number;
  end: number;
  /** How to resolve conflicts with existing markers */
  resolveType: BulkResolveType;
  /** Episode IDs to skip */
  ignoredEpisodes?: number[];
}

export interface BulkDeleteRequest {
  /** Show or season metadata ID */
  metadataId: number;
  /** Which marker types to delete */
  applyTo: number;
  /** Marker IDs to keep */
  ignoredMarkerIds?: number[];
}

export interface BulkShiftRequest {
  /** Show, season, or episode metadata ID */
  metadataId: number;
  startShift: number;
  endShift: number;
  /** Which marker types to shift */
  applyTo: number;
  /** Marker IDs to skip */
  ignoredMarkerIds?: number[];
}

export enum BulkResolveType {
  /** Just check what would happen, don't apply */
  DryRun = 0,
  /** Fail if any conflicts exist */
  Fail = 1,
  /** Merge overlapping markers into one */
  Merge = 2,
  /** Skip episodes that have conflicts */
  Ignore = 3,
  /** Delete existing markers that conflict */
  Overwrite = 4,
}

export interface BulkPreviewResult {
  /** Number of markers that would be added */
  additions: number;
  /** Number of markers that would be modified */
  modifications: number;
  /** Number of markers that would be deleted */
  deletions: number;
  /** Markers that would be affected, with before/after state */
  affected: BulkAffectedMarker[];
  /** Whether conflicts exist */
  hasConflicts: boolean;
}

export interface BulkAffectedMarker {
  episodeId: number;
  episodeTitle: string;
  seasonIndex: number;
  episodeIndex: number;
  action: 'add' | 'edit' | 'delete';
  before?: Marker;
  after?: Partial<Marker>;
}

export type BulkPreviewResponse = ApiResponse<BulkPreviewResult>;
export type BulkCommitResponse = ApiResponse<{ markersAffected: number }>;

// ── Chapters ─────────────────────────────────────────────────────

export type GetChaptersResponse = ApiResponse<ChapterData>;

export interface SetChaptersRequest {
  chapters: { name: string; start: number; end: number }[];
}
export type SetChaptersResponse = ApiResponse<ChapterData>;

export type ClearChaptersResponse = ApiResponse<void>;

// ── Media / Video ─────────────────────────────────────────────────

export type GetMediaInfoResponse = ApiResponse<MediaInfo>;

// ── Session & Safety ──────────────────────────────────────────────

export interface SessionStatus {
  connected: boolean;
  dbPath: string;
  dbFileSize: number;
  dbLastModified: number;
  snapshotTakenAt: number;
  markerCount: number;
}

export type GetSessionResponse = ApiResponse<SessionStatus>;
export type GetWriteHistoryResponse = ApiResponse<WriteHistoryEntry[]>;
export type CheckConflictsResponse = ApiResponse<ConflictInfo | null>;

// ── System ────────────────────────────────────────────────────────

export interface SystemStatus {
  connected: boolean;
  dbPath: string;
  uptime: number;
  dbFileSize: number;
  dbLastModified: number;
  backupCount: number;
  writeMode: 'hybrid-writes';
  plexSqlitePath: string | null;
  plexSqliteAvailable: boolean;
  plexSqliteStartupError: string | null;
  plexConfigured: boolean;
  plexReachable: boolean;
  plexAuthSource: PlexAuthSource | null;
  plexStartupError: string | null;
  lastIntegrityCheck: DbCheckResult | null;
}

export type PlexAuthSource = 'env' | 'preferences-xml' | 'macos-plist' | 'windows-registry';

export interface BackupInfo {
  id: string;
  filename: string;
  createdAt: number;
  size: number;
}

export type GetStatusResponse = ApiResponse<SystemStatus>;
export type GetBackupsResponse = ApiResponse<BackupInfo[]>;
export type CreateBackupResponse = ApiResponse<BackupInfo>;
export type RestoreBackupResponse = ApiResponse<void>;
export type RunDbCheckResponse = ApiResponse<DbCheckResult>;

// ── Auth ─────────────────────────────────────────────────────────

export interface AuthUser {
  id: number;
  username: string;
  email: string;
  thumb: string;
  isOwner: boolean;
}

export interface AuthSession {
  user: AuthUser;
  expiresAt: number;
}

export interface PinResponse {
  id: number;
  code: string;
  authUrl: string;
}

export type GetAuthSessionResponse = ApiResponse<AuthSession | null>;
export type CreatePinResponse = ApiResponse<PinResponse>;
export type CheckPinResponse = ApiResponse<{ ready: boolean; token?: string }>;
export type LoginResponse = ApiResponse<AuthUser>;

// ── Access Control (Admin) ───────────────────────────────────────

/** A user in the Plex Home that the server owner can grant access to */
export interface PlexHomeUser {
  id: number;
  username: string;
  email: string;
  thumb: string;
  friendlyName: string;
}

/** An entry in the allowed-users list */
export interface AllowedUserEntry {
  /** Username or email (stored lowercase) */
  value: string;
  /** Optional label — populated from Plex Home data when available */
  label: string;
  /** Where this entry came from */
  source: 'manual' | 'plex-home';
  /** Profile picture URL, if resolved */
  thumb?: string;
}

/** Shape returned by GET /api/admin/allowed-users */
export interface AllowedUsersData {
  entries: AllowedUserEntry[];
  /** When true, all Plex Home users are granted access automatically */
  plexHomeAllowed: boolean;
}

/** Result of validating a username/email against the Plex friends list */
export interface PlexUserValidation {
  found: boolean;
  id?: number;
  username?: string;
  email?: string;
  thumb?: string;
}

export type GetAllowedUsersResponse = ApiResponse<AllowedUsersData>;
export type AddAllowedUserResponse = ApiResponse<AllowedUsersData>;
export type RemoveAllowedUserResponse = ApiResponse<AllowedUsersData>;
export type GetPlexHomeUsersResponse = ApiResponse<PlexHomeUser[]>;
export type ValidatePlexUserResponse = ApiResponse<PlexUserValidation>;
