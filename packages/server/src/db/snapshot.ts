import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { SafeDB } from './connection.js';
import type { DbSnapshot } from '@plex-meta-editor/shared';

/**
 * Take a snapshot of the current marker state in the Plex database.
 * Used to detect if Plex has changed the DB between our operations.
 */
export function takeSnapshot(db: SafeDB, markerTagId: number): DbSnapshot {
  const rows = db.all<{
    id: number; metadata_item_id: number; index: number; text: string;
    time_offset: number; end_time_offset: number; created_at: number;
    extra_data: string;
  }>(
    `SELECT id, metadata_item_id, \`index\`, text, time_offset,
            end_time_offset, created_at, extra_data
     FROM taggings
     WHERE tag_id = ?
     ORDER BY id`,
    markerTagId
  );

  // Build overall hash and per-marker hashes
  const overallHash = createHash('sha256');
  const markerHashesById: Record<number, string> = {};

  for (const row of rows) {
    const rowStr = JSON.stringify(row);
    overallHash.update(rowStr);
    markerHashesById[row.id] = createHash('sha256').update(rowStr).digest('hex');
  }

  // File metadata
  const stat = fs.statSync(db.path);

  return {
    takenAt: Date.now(),
    dbFileModifiedAt: stat.mtimeMs,
    dbFileSize: stat.size,
    markerCount: rows.length,
    markerHash: overallHash.digest('hex'),
    markerHashesById,
  };
}

/**
 * Quick check: has anything changed since the last snapshot?
 * This is a fast check using file metadata — if it returns false,
 * no need for the more expensive row-level comparison.
 */
export function hasDbFileChanged(snapshot: DbSnapshot, dbPath: string): boolean {
  try {
    const stat = fs.statSync(dbPath);
    return stat.mtimeMs !== snapshot.dbFileModifiedAt || stat.size !== snapshot.dbFileSize;
  } catch {
    return true; // If we can't stat, assume changed
  }
}

/**
 * Detailed comparison between two snapshots.
 * Returns the specific differences at the marker level.
 */
export interface SnapshotDiff {
  /** Marker IDs that exist in 'after' but not in 'before' */
  addedIds: number[];
  /** Marker IDs that exist in 'before' but not in 'after' */
  deletedIds: number[];
  /** Marker IDs that exist in both but have different content */
  modifiedIds: number[];
  /** Whether any changes were detected */
  hasChanges: boolean;
}

export function compareSnapshots(before: DbSnapshot, after: DbSnapshot): SnapshotDiff {
  // Quick path: if overall hash matches, nothing changed
  if (before.markerHash === after.markerHash) {
    return { addedIds: [], deletedIds: [], modifiedIds: [], hasChanges: false };
  }

  const beforeIds = new Set(Object.keys(before.markerHashesById).map(Number));
  const afterIds = new Set(Object.keys(after.markerHashesById).map(Number));

  const addedIds: number[] = [];
  const deletedIds: number[] = [];
  const modifiedIds: number[] = [];

  // Find added IDs (in after but not before)
  for (const id of afterIds) {
    if (!beforeIds.has(id)) {
      addedIds.push(id);
    }
  }

  // Find deleted IDs (in before but not after)
  for (const id of beforeIds) {
    if (!afterIds.has(id)) {
      deletedIds.push(id);
    }
  }

  // Find modified IDs (in both but different hash)
  for (const id of beforeIds) {
    if (afterIds.has(id) && before.markerHashesById[id] !== after.markerHashesById[id]) {
      modifiedIds.push(id);
    }
  }

  return {
    addedIds,
    deletedIds,
    modifiedIds,
    hasChanges: addedIds.length > 0 || deletedIds.length > 0 || modifiedIds.length > 0,
  };
}
