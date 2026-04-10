/**
 * Atomic mutation builders for the Plex database.
 *
 * KEY SAFETY PRINCIPLE: Every mutation function returns an array of SQL statements
 * that must ALL be executed within a SINGLE transaction. The reindex is always
 * included in the same set of statements — never separate.
 *
 * This is the critical fix over MarkerEditorForPlex, which ran reindex separately.
 */

import type { Marker, NewMarker, UpdateMarker, MarkerType } from '@plex-meta-editor/shared';
import { ExtraData } from '@plex-meta-editor/shared';
import type { SafeDB } from '../db/connection.js';
import { getMarkersRaw } from './queries.js';

export interface SqlStatement {
  sql: string;
  params: unknown[];
}

/** Thrown when a marker overlaps with an existing same-type marker */
export class OverlapError extends Error {
  readonly newStart: number;
  readonly newEnd: number;
  readonly existingStart: number;
  readonly existingEnd: number;

  constructor(message: string, newStart: number, newEnd: number, existingStart: number, existingEnd: number) {
    super(message);
    this.name = 'OverlapError';
    this.newStart = newStart;
    this.newEnd = newEnd;
    this.existingStart = existingStart;
    this.existingEnd = existingEnd;
  }
}

// ── Add Marker ─────────────────────────────────────────────────────

/**
 * Build the SQL statements needed to add a marker AND reindex.
 * All returned statements must run in a single transaction.
 */
export function buildAddMarkerStatements(
  marker: NewMarker,
  existingMarkers: Marker[],
  tagId: number,
): SqlStatement[] {
  const statements: SqlStatement[] = [];

  // Calculate where the new marker fits in the index order
  const allPositions = [
    ...existingMarkers.map(m => ({ start: m.start, end: m.end, id: m.id, index: m.index, type: m.type })),
    { start: marker.start, end: marker.end, id: -1, index: -1, type: marker.type }, // -1 = new marker placeholder
  ].sort((a, b) => a.start - b.start);

  // Assign new indexes
  const newIndex = allPositions.findIndex(p => p.id === -1);

  // Check for overlaps with same-type markers only.
  // Plex allows markers of different types to overlap (e.g. intro + credits).
  const sameTypeNeighbors = allPositions.filter(p => p.id !== -1 && p.type === marker.type);
  for (const neighbor of sameTypeNeighbors) {
    if (marker.start < neighbor.end && marker.end > neighbor.start) {
      throw new OverlapError(
        `New ${marker.type} marker overlaps with an existing ${neighbor.type} marker`,
        marker.start, marker.end, neighbor.start, neighbor.end,
      );
    }
  }

  // INSERT the new marker
  const extraData = ExtraData.build(marker.type, marker.isFinal);
  statements.push({
    sql: `INSERT INTO taggings (metadata_item_id, tag_id, \`index\`, text, time_offset, end_time_offset, thumb_url, created_at, extra_data)
          VALUES (?, ?, ?, ?, ?, ?, '', strftime('%s','now'), ?)`,
    params: [marker.parentId, tagId, newIndex, marker.type, marker.start, marker.end, extraData],
  });

  // Reindex all existing markers that need their index updated
  for (let i = 0; i < allPositions.length; i++) {
    const pos = allPositions[i];
    if (pos.id !== -1 && pos.index !== i) {
      statements.push({
        sql: `UPDATE taggings SET \`index\` = ? WHERE id = ?`,
        params: [i, pos.id],
      });
    }
  }

  return statements;
}

// ── Edit Marker ────────────────────────────────────────────────────

/**
 * Build the SQL statements needed to edit a marker AND reindex.
 */
export function buildEditMarkerStatements(
  update: UpdateMarker,
  existingMarkers: Marker[],
): SqlStatement[] {
  const statements: SqlStatement[] = [];

  // Build the new ordering with the updated marker
  const allPositions = existingMarkers.map(m => {
    if (m.id === update.id) {
      return { start: update.start, end: update.end, id: m.id, index: m.index, type: update.type };
    }
    return { start: m.start, end: m.end, id: m.id, index: m.index, type: m.type };
  }).sort((a, b) => a.start - b.start);

  // Find new index of the edited marker
  const newIndex = allPositions.findIndex(p => p.id === update.id);

  // Check for overlaps with same-type markers only
  const sameTypeNeighbors = allPositions.filter(p => p.id !== update.id && p.type === update.type);
  for (const neighbor of sameTypeNeighbors) {
    if (update.start < neighbor.end && update.end > neighbor.start) {
      throw new OverlapError(
        `Edited ${update.type} marker overlaps with an existing ${neighbor.type} marker`,
        update.start, update.end, neighbor.start, neighbor.end,
      );
    }
  }

  // UPDATE the marker
  const extraData = ExtraData.build(update.type, update.isFinal);
  statements.push({
    sql: `UPDATE taggings SET \`index\` = ?, text = ?, time_offset = ?, end_time_offset = ?, extra_data = ? WHERE id = ?`,
    params: [newIndex, update.type, update.start, update.end, extraData, update.id],
  });

  // Reindex others if needed
  for (let i = 0; i < allPositions.length; i++) {
    const pos = allPositions[i];
    if (pos.id !== update.id && pos.index !== i) {
      statements.push({
        sql: `UPDATE taggings SET \`index\` = ? WHERE id = ?`,
        params: [i, pos.id],
      });
    }
  }

  return statements;
}

// ── Delete Marker ──────────────────────────────────────────────────

/**
 * Build the SQL statements needed to delete a marker AND reindex.
 */
export function buildDeleteMarkerStatements(
  markerId: number,
  existingMarkers: Marker[],
): SqlStatement[] {
  const statements: SqlStatement[] = [];

  // DELETE the marker
  statements.push({
    sql: `DELETE FROM taggings WHERE id = ?`,
    params: [markerId],
  });

  // Reindex remaining markers
  const remaining = existingMarkers
    .filter(m => m.id !== markerId)
    .sort((a, b) => a.start - b.start);

  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i].index !== i) {
      statements.push({
        sql: `UPDATE taggings SET \`index\` = ? WHERE id = ?`,
        params: [i, remaining[i].id],
      });
    }
  }

  return statements;
}

// ── Bulk Add ───────────────────────────────────────────────────────

/**
 * Build statements for bulk adding markers to multiple episodes.
 * Returns statements for all episodes, plus info about what was skipped.
 */
export function buildBulkAddStatements(
  db: SafeDB,
  tagId: number,
  sectionId: number,
  episodeIds: number[],
  type: MarkerType,
  start: number,
  end: number,
  ignoredEpisodes: Set<number> = new Set(),
): { statements: SqlStatement[]; added: number; skipped: number } {
  const statements: SqlStatement[] = [];
  let added = 0;
  let skipped = 0;

  for (const episodeId of episodeIds) {
    if (ignoredEpisodes.has(episodeId)) {
      skipped++;
      continue;
    }

    const existing = getMarkersRaw(db, tagId, episodeId, sectionId);

    // Check for overlaps
    const hasOverlap = existing.some(m =>
      (start < m.end && end > m.start)
    );

    if (hasOverlap) {
      skipped++;
      continue;
    }

    try {
      const addStmts = buildAddMarkerStatements(
        { parentId: episodeId, type, start, end, isFinal: false },
        existing,
        tagId,
      );
      statements.push(...addStmts);
      added++;
    } catch {
      skipped++;
    }
  }

  return { statements, added, skipped };
}

// ── Bulk Delete ────────────────────────────────────────────────────

/**
 * Build statements for bulk deleting markers matching criteria.
 */
export function buildBulkDeleteStatements(
  db: SafeDB,
  tagId: number,
  sectionId: number,
  episodeIds: number[],
  markerTypeFilter: string | null,
  ignoredMarkerIds: Set<number> = new Set(),
): { statements: SqlStatement[]; deleted: number } {
  const statements: SqlStatement[] = [];
  let deleted = 0;

  for (const episodeId of episodeIds) {
    const existing = getMarkersRaw(db, tagId, episodeId, sectionId);

    const toDelete = existing.filter(m =>
      !ignoredMarkerIds.has(m.id) &&
      (markerTypeFilter === null || m.type === markerTypeFilter)
    );

    if (toDelete.length === 0) continue;

    // Delete each marker
    for (const marker of toDelete) {
      statements.push({
        sql: `DELETE FROM taggings WHERE id = ?`,
        params: [marker.id],
      });
      deleted++;
    }

    // Reindex remaining
    const remaining = existing
      .filter(m => !toDelete.some(d => d.id === m.id))
      .sort((a, b) => a.start - b.start);

    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i].index !== i) {
        statements.push({
          sql: `UPDATE taggings SET \`index\` = ? WHERE id = ?`,
          params: [i, remaining[i].id],
        });
      }
    }
  }

  return { statements, deleted };
}

// ── Bulk Shift ─────────────────────────────────────────────────────

/**
 * Build statements for bulk shifting markers by a time offset.
 */
export function buildBulkShiftStatements(
  db: SafeDB,
  tagId: number,
  sectionId: number,
  episodeIds: number[],
  startShift: number,
  endShift: number,
  markerTypeFilter: string | null,
  ignoredMarkerIds: Set<number> = new Set(),
): { statements: SqlStatement[]; shifted: number } {
  const statements: SqlStatement[] = [];
  let shifted = 0;

  for (const episodeId of episodeIds) {
    const existing = getMarkersRaw(db, tagId, episodeId, sectionId);

    // Get episode duration for bounds checking
    const episode = db.get<{ duration: number }>(
      'SELECT duration FROM metadata_items WHERE id = ?',
      episodeId
    );
    const maxDuration = episode?.duration || Infinity;

    for (const marker of existing) {
      if (ignoredMarkerIds.has(marker.id)) continue;
      if (markerTypeFilter !== null && marker.type !== markerTypeFilter) continue;

      const newStart = Math.max(0, Math.min(marker.start + startShift, maxDuration));
      const newEnd = Math.max(0, Math.min(marker.end + endShift, maxDuration));

      if (newStart >= newEnd) continue; // Would collapse to zero-length, skip

      statements.push({
        sql: `UPDATE taggings SET time_offset = ?, end_time_offset = ? WHERE id = ?`,
        params: [newStart, newEnd, marker.id],
      });
      shifted++;
    }
  }

  return { statements, shifted };
}
