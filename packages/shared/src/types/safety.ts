// Safety-related types: snapshots, conflicts, change tracking

import type { Marker } from './plex.js';

/** A snapshot of the Plex DB marker state at a point in time */
export interface DbSnapshot {
  /** When this snapshot was taken (Unix ms) */
  takenAt: number;
  /** File mtime of the DB at snapshot time */
  dbFileModifiedAt: number;
  /** File size at snapshot time */
  dbFileSize: number;
  /** Total number of markers */
  markerCount: number;
  /** SHA-256 hash of all marker rows ordered by ID */
  markerHash: string;
  /** Per-marker hashes keyed by marker ID, for granular conflict detection */
  markerHashesById: Record<number, string>;
}

/** Describes a single change to be written */
export interface ChangeSet {
  id: string;
  type: 'add' | 'edit' | 'delete';
  /** For adds: the new marker data (without id). For edits: the updated marker. For deletes: the marker being deleted. */
  marker: Marker | Omit<Marker, 'id'>;
  /** For edits: the state before our change */
  previousState?: Marker;
  timestamp: number;
}

/** Information about conflicts between our changes and what Plex did */
export interface ConflictInfo {
  /** Markers Plex added since our snapshot */
  plexAdded: Marker[];
  /** Markers Plex modified since our snapshot */
  plexModified: PlexModifiedMarker[];
  /** Marker IDs that Plex deleted since our snapshot */
  plexDeleted: number[];
  /** Our changes that are affected by Plex's changes */
  ourChangesAffected: ChangeSet[];
  /** Whether any real conflicts exist (vs. safe-to-merge changes) */
  hasConflicts: boolean;
}

export interface PlexModifiedMarker {
  markerId: number;
  before: Marker;
  after: Marker;
}

/** Result of a full-database integrity check */
export interface DbCheckResult {
  ok: boolean;
  issues: string[];
  checkedAt: number;
  durationMs: number;
  checker: 'plex-sqlite';
  trigger: 'write' | 'manual';
}

/** Result of running the safety pipeline */
export interface PipelineResult {
  success: boolean;
  /** Suggested HTTP status for API callers on failure */
  statusCode?: number;
  /** The backup file created before writing */
  backupPath?: string;
  /** Number of SQL statements executed */
  statementsExecuted: number;
  /** Number of markers affected */
  markersAffected: number;
  /** Integrity check result */
  integrityOk: boolean;
  /** Error message if failed */
  error?: string;
  /** If conflict was detected, the conflict info */
  conflict?: ConflictInfo;
}

/** A record of a write operation for the history log */
export interface WriteHistoryEntry {
  id: string;
  timestamp: number;
  /** What kind of operation was performed */
  operation: 'add' | 'edit' | 'delete' | 'bulk-add' | 'bulk-delete' | 'bulk-shift';
  /** Human-readable description */
  description: string;
  /** Number of markers affected */
  markersAffected: number;
  /** Path to the backup file created before this write */
  backupPath: string;
  /** Whether this write was successful */
  success: boolean;
}
