/**
 * Conflict detection between our pending changes and what Plex may have changed.
 */

import type { SafeDB } from '../db/connection.js';
import type { ConflictInfo, DbSnapshot, ChangeSet } from '@plex-meta-editor/shared';
import type { Marker } from '@plex-meta-editor/shared';
import { takeSnapshot, compareSnapshots, type SnapshotDiff } from '../db/snapshot.js';
import { getMarkersRaw } from '../plex/queries.js';

/**
 * Detect conflicts between our pending changes and what Plex has done to the DB.
 *
 * @param db - Read-only DB connection
 * @param lastSnapshot - The snapshot taken when we last read the DB
 * @param markerTagId - The marker tag ID
 * @param changes - Our pending changes (for bulk operations)
 * @returns ConflictInfo if there are Plex changes, null if no changes detected
 */
export function detectConflicts(
  db: SafeDB,
  lastSnapshot: DbSnapshot,
  markerTagId: number,
  changes: ChangeSet[] = [],
): ConflictInfo | null {
  // Take a fresh snapshot
  const currentSnapshot = takeSnapshot(db, markerTagId);
  const diff = compareSnapshots(lastSnapshot, currentSnapshot);

  if (!diff.hasChanges) {
    return null; // No changes by Plex — safe to proceed
  }

  return buildConflictInfo(db, diff, markerTagId, changes);
}

/**
 * Build detailed conflict information from a snapshot diff.
 */
function buildConflictInfo(
  db: SafeDB,
  diff: SnapshotDiff,
  markerTagId: number,
  changes: ChangeSet[],
): ConflictInfo {
  // Fetch the actual marker data for added/modified markers
  const plexAdded: Marker[] = [];
  const plexModified: { markerId: number; before: Marker; after: Marker }[] = [];

  // Get added markers
  if (diff.addedIds.length > 0) {
    for (const id of diff.addedIds) {
      const rows = db.all<{
        id: number; metadata_item_id: number; idx: number; text: string;
        time_offset: number; end_time_offset: number; created_at: number;
        extra_data: string; library_section_id: number;
      }>(
        `SELECT t.id, t.metadata_item_id, t.\`index\` as idx, t.text, t.time_offset,
                t.end_time_offset, t.created_at, t.extra_data, mi.library_section_id
         FROM taggings t
         JOIN metadata_items mi ON t.metadata_item_id = mi.id
         WHERE t.id = ? AND t.tag_id = ?`,
        id, markerTagId
      );
      if (rows.length > 0) {
        const r = rows[0];
        plexAdded.push({
          id: r.id,
          parentId: r.metadata_item_id,
          sectionId: r.library_section_id,
          index: r.idx,
          type: r.text as Marker['type'],
          start: r.time_offset,
          end: r.end_time_offset,
          isFinal: false,
          createdAt: r.created_at,
          extraData: r.extra_data || '',
        });
      }
    }
  }

  // Determine which of our changes are affected
  const ourChangesAffected: ChangeSet[] = [];
  const changedParentIds = new Set<number>([
    ...plexAdded.map(m => m.parentId),
  ]);

  // Markers Plex deleted — if we were editing them, that's a conflict
  for (const deletedId of diff.deletedIds) {
    const affected = changes.find(c =>
      c.type === 'edit' && 'id' in c.marker && c.marker.id === deletedId
    );
    if (affected) {
      ourChangesAffected.push(affected);
    }
  }

  // Markers Plex modified — if we were also editing them, that's a conflict
  for (const modifiedId of diff.modifiedIds) {
    const affected = changes.find(c =>
      c.type === 'edit' && 'id' in c.marker && c.marker.id === modifiedId
    );
    if (affected) {
      ourChangesAffected.push(affected);
    }
  }

  // If we're adding markers to an episode where Plex also added markers, that could overlap
  for (const change of changes) {
    if (change.type === 'add' && changedParentIds.has(change.marker.parentId)) {
      ourChangesAffected.push(change);
    }
  }

  return {
    plexAdded,
    plexModified,
    plexDeleted: diff.deletedIds,
    ourChangesAffected,
    hasConflicts: ourChangesAffected.length > 0,
  };
}
