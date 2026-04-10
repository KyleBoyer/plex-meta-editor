/**
 * Read-only queries for chapter data in the Plex database.
 *
 * Chapters are stored in media_parts.extra_data as a JSON blob.
 * The `pv:chapters` key contains a JSON-encoded string with this structure:
 *
 *   {"Chapters":{"Chapter":[{"name":"","start":0.0,"end":234.693}, ...]}}
 *
 * Times in the DB are in SECONDS (float). We convert to milliseconds throughout
 * the app for consistency with marker handling.
 *
 * The extra_data field also holds pv:intros, pv:credits, pv:commercials, and
 * various ma:/mi: keys — all of which must be preserved when writing.
 */

import type { SafeDB } from '../db/connection.js';
import type { Chapter, ChapterData } from '@plex-meta-editor/shared';

// ── Raw Plex chapter JSON shapes ─────────────────────────────────

interface PlexChapterEntry {
  name: string;
  start: number; // seconds
  end: number;   // seconds
}

interface PlexChaptersWrapper {
  Chapters: Record<string, never> | { Chapter: PlexChapterEntry[] };
}

// ── Public Queries ───────────────────────────────────────────────

/**
 * Get chapters for a metadata item (episode or movie).
 * Joins metadata_items → media_items → media_parts to find the media file,
 * then parses chapter data from media_parts.extra_data.
 */
export function getChapters(db: SafeDB, metadataId: number): ChapterData | null {
  const row = db.get<{ part_id: number; extra_data: string }>(
    `SELECT mp.id as part_id, mp.extra_data
     FROM media_items mi
     JOIN media_parts mp ON mp.media_item_id = mi.id
     WHERE mi.metadata_item_id = ?
     ORDER BY mi.id ASC
     LIMIT 1`,
    metadataId
  );

  if (!row || !row.extra_data) return null;

  const chapters = parseChaptersFromExtraData(row.extra_data);
  return { chapters };
}

/**
 * Get chapters directly by media_parts.id.
 */
export function getChaptersByPartId(db: SafeDB, partId: number): ChapterData | null {
  const row = db.get<{ id: number; extra_data: string }>(
    'SELECT id, extra_data FROM media_parts WHERE id = ?',
    partId
  );

  if (!row || !row.extra_data) return null;

  const chapters = parseChaptersFromExtraData(row.extra_data);
  return { chapters };
}

/**
 * Get the raw extra_data string for a media part.
 * Needed by mutation builders to do safe read-modify-write.
 */
export function getMediaPartExtraData(db: SafeDB, partId: number): string | null {
  const row = db.get<{ extra_data: string }>(
    'SELECT extra_data FROM media_parts WHERE id = ?',
    partId
  );
  return row?.extra_data ?? null;
}

/**
 * Find the media part for a metadata item and return both partId and extra_data in one query.
 * Used by route handlers to avoid separate find-part + get-extra-data queries.
 */
export function getMediaPartForMetadata(db: SafeDB, metadataId: number): { partId: number; extraData: string } | null {
  const row = db.get<{ part_id: number; extra_data: string }>(
    `SELECT mp.id as part_id, mp.extra_data
     FROM media_items mi
     JOIN media_parts mp ON mp.media_item_id = mi.id
     WHERE mi.metadata_item_id = ?
     ORDER BY mi.id ASC
     LIMIT 1`,
    metadataId
  );
  if (!row || !row.extra_data) return null;
  return { partId: row.part_id, extraData: row.extra_data };
}

/**
 * Bulk fetch chapter start positions for multiple metadata items.
 * Returns only the start time of each chapter (enough to render boundary lines).
 */
export function getChapterSummary(
  db: SafeDB, metadataIds: number[],
): Map<number, number[]> {
  if (metadataIds.length === 0) return new Map();

  const placeholders = metadataIds.map(() => '?').join(',');
  const rows = db.all<{ metadata_item_id: number; extra_data: string }>(
    `SELECT mi.metadata_item_id, mp.extra_data
     FROM media_items mi
     JOIN media_parts mp ON mp.media_item_id = mi.id
     WHERE mi.metadata_item_id IN (${placeholders})
     ORDER BY mi.metadata_item_id, mi.id`,
    ...metadataIds
  );

  const result = new Map<number, number[]>();
  const seen = new Set<number>();
  for (const row of rows) {
    // Only use the first media part per metadata item
    if (seen.has(row.metadata_item_id)) continue;
    seen.add(row.metadata_item_id);
    if (!row.extra_data) continue;
    const chapters = parseChaptersFromExtraData(row.extra_data);
    if (chapters.length > 1) {
      // Return start positions of chapters (skip first which is always 0)
      result.set(row.metadata_item_id, chapters.slice(1).map(c => c.start));
    }
  }
  return result;
}

// ── Parsing Helpers ──────────────────────────────────────────────

/**
 * Parse chapters from the full media_parts.extra_data JSON string.
 * Returns an empty array if no chapters exist.
 */
export function parseChaptersFromExtraData(extraData: string): Chapter[] {
  if (!extraData) return [];

  try {
    const parsed = JSON.parse(extraData) as Record<string, unknown>;
    const chaptersJson = parsed['pv:chapters'];
    if (!chaptersJson || typeof chaptersJson !== 'string') return [];
    return parseChapterJson(chaptersJson);
  } catch {
    return [];
  }
}

/**
 * Parse the pv:chapters JSON value into our Chapter[] type.
 * Input is the decoded value of the pv:chapters key, e.g.:
 *   {"Chapters":{"Chapter":[{"name":"","start":0.0,"end":234.693}]}}
 */
export function parseChapterJson(chaptersJsonStr: string): Chapter[] {
  if (!chaptersJsonStr) return [];

  try {
    const wrapper = JSON.parse(chaptersJsonStr) as PlexChaptersWrapper;

    if (!wrapper.Chapters || !('Chapter' in wrapper.Chapters)) {
      return []; // Empty chapters: {"Chapters":{}}
    }

    const entries = wrapper.Chapters.Chapter;
    if (!Array.isArray(entries)) return [];

    return entries.map(entry => ({
      name: entry.name || '',
      start: Math.round(entry.start * 1000), // seconds → ms
      end: Math.round(entry.end * 1000),     // seconds → ms
    }));
  } catch {
    return [];
  }
}

/**
 * Build the pv:chapters JSON value string from our Chapter[] type.
 * Converts ms back to seconds (float) for Plex storage format.
 * Returns the JSON string to be stored as the pv:chapters value.
 */
export function buildChapterJson(chapters: Chapter[]): string {
  if (chapters.length === 0) {
    return JSON.stringify({ Chapters: {} });
  }

  const entries: PlexChapterEntry[] = chapters.map(ch => ({
    name: ch.name,
    start: ch.start / 1000, // ms → seconds
    end: ch.end / 1000,     // ms → seconds
  }));

  return JSON.stringify({ Chapters: { Chapter: entries } });
}

/**
 * Update the pv:chapters key in a full extra_data JSON string.
 * Preserves all other keys (pv:intros, pv:credits, pv:commercials, ma:*, mi:*, etc.).
 *
 * @param currentExtraData - The current full extra_data string from the DB
 * @param chapters - New chapter list (empty array = clear chapters)
 * @returns The new full extra_data string to write back
 */
export function updateChaptersInExtraData(currentExtraData: string, chapters: Chapter[]): string {
  const parsed = JSON.parse(currentExtraData) as Record<string, unknown>;
  parsed['pv:chapters'] = buildChapterJson(chapters);
  return JSON.stringify(parsed);
}
