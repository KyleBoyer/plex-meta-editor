/**
 * Read-only queries for the Plex database.
 * These never modify data — they only SELECT.
 */

import type { SafeDB } from '../db/connection.js';
import type { Library, Show, Season, Episode, Movie, Marker, MediaInfo } from '@plex-meta-editor/shared';
import { ExtraData } from '@plex-meta-editor/shared';
import { getMarkerTagId, PlexMetadataType } from './schema.js';

// ── Libraries ──────────────────────────────────────────────────────

export function getLibraries(db: SafeDB): Library[] {
  const rows = db.all<{ id: number; name: string; section_type: number; uuid: string }>(
    'SELECT id, name, section_type, uuid FROM library_sections ORDER BY name'
  );
  return rows.map(r => ({ id: r.id, name: r.name, type: r.section_type, uuid: r.uuid }));
}

// ── Shows ──────────────────────────────────────────────────────────

export function getShows(db: SafeDB, libraryId: number): Show[] {
  const rows = db.all<{
    id: number; title: string; title_sort: string; original_title: string;
    season_count: number; episode_count: number;
    year: number; summary: string; content_rating: string; rating: number | null;
    tags_genre: string; studio: string;
  }>(
    `SELECT mi.id, mi.title, mi.title_sort, mi.original_title,
            mi.year, mi.summary, mi.content_rating, mi.rating, mi.tags_genre, mi.studio,
            (SELECT COUNT(*) FROM metadata_items s WHERE s.parent_id = mi.id AND s.metadata_type = 3) as season_count,
            (SELECT COUNT(*) FROM metadata_items e WHERE e.parent_id IN
              (SELECT s2.id FROM metadata_items s2 WHERE s2.parent_id = mi.id AND s2.metadata_type = 3)
              AND e.metadata_type = 4) as episode_count
     FROM metadata_items mi
     WHERE mi.library_section_id = ? AND mi.metadata_type = ?
     ORDER BY mi.title_sort`,
    libraryId, PlexMetadataType.Show
  );

  return rows.map(r => ({
    id: r.id,
    title: r.title,
    sortTitle: r.title_sort || r.title,
    originalTitle: r.original_title || '',
    seasonCount: r.season_count,
    episodeCount: r.episode_count,
    year: r.year || 0,
    summary: r.summary || '',
    contentRating: r.content_rating || '',
    rating: r.rating ?? null,
    genres: r.tags_genre || '',
    studio: r.studio || '',
    libraryId,
  }));
}

// ── Seasons ────────────────────────────────────────────────────────

export function getSeasons(db: SafeDB, showId: number): Season[] {
  const show = db.get<{ title: string; library_section_id: number }>(
    'SELECT title, library_section_id FROM metadata_items WHERE id = ? AND metadata_type = ?',
    showId, PlexMetadataType.Show
  );
  if (!show) return [];

  const rows = db.all<{
    id: number; title: string; idx: number; episode_count: number;
  }>(
    `SELECT mi.id, mi.title, mi.\`index\` as idx,
            (SELECT COUNT(*) FROM metadata_items e WHERE e.parent_id = mi.id AND e.metadata_type = ?) as episode_count
     FROM metadata_items mi
     WHERE mi.parent_id = ? AND mi.metadata_type = ?
     ORDER BY mi.\`index\``,
    PlexMetadataType.Episode, showId, PlexMetadataType.Season
  );

  return rows.map(r => ({
    id: r.id,
    title: r.title || `Season ${r.idx}`,
    showId,
    showTitle: show.title,
    index: r.idx,
    episodeCount: r.episode_count,
    libraryId: show.library_section_id,
  }));
}

// ── Episodes ───────────────────────────────────────────────────────

export function getEpisodes(db: SafeDB, seasonId: number): Episode[] {
  const season = db.get<{
    id: number; idx: number; show_id: number; show_title: string; library_section_id: number;
  }>(
    `SELECT s.id, s.\`index\` as idx, sh.id as show_id, sh.title as show_title, s.library_section_id
     FROM metadata_items s
     JOIN metadata_items sh ON s.parent_id = sh.id AND sh.metadata_type = ?
     WHERE s.id = ? AND s.metadata_type = ?`,
    PlexMetadataType.Show, seasonId, PlexMetadataType.Season
  );
  if (!season) return [];

  const rows = db.all<{
    id: number; title: string; idx: number; duration: number; media_file_path: string; file_duration: number;
  }>(
    `SELECT e.id, e.title, e.\`index\` as idx, e.duration,
            COALESCE(mp.file, '') as media_file_path,
            COALESCE(mi.duration, 0) as file_duration
     FROM metadata_items e
     LEFT JOIN media_items mi ON mi.metadata_item_id = e.id
     LEFT JOIN media_parts mp ON mp.media_item_id = mi.id
     WHERE e.parent_id = ? AND e.metadata_type = ?
     ORDER BY e.\`index\``,
    seasonId, PlexMetadataType.Episode
  );

  return rows.map(r => ({
    id: r.id,
    title: r.title,
    showId: season.show_id,
    showTitle: season.show_title,
    seasonId,
    seasonIndex: season.idx,
    index: r.idx,
    duration: r.duration || 0,
    libraryId: season.library_section_id,
    mediaFilePath: r.media_file_path,
    fileDuration: r.file_duration,
  }));
}

// ── Movies ─────────────────────────────────────────────────────────

export function getMovies(db: SafeDB, libraryId: number): Movie[] {
  const rows = db.all<{
    id: number; title: string; title_sort: string; original_title: string;
    year: number; edition_title: string; summary: string; content_rating: string; rating: number | null;
    duration: number; file_duration: number;
  }>(
    `SELECT mi.id, mi.title, mi.title_sort, mi.original_title, mi.year, mi.edition_title,
            mi.summary, mi.content_rating, mi.rating, mi.duration,
            COALESCE((
              SELECT MAX(mdi.duration)
              FROM media_items mdi
              WHERE mdi.metadata_item_id = mi.id
            ), 0) as file_duration
     FROM metadata_items mi
     WHERE mi.library_section_id = ? AND mi.metadata_type = ?
     ORDER BY mi.title_sort`,
    libraryId, PlexMetadataType.Movie
  );

  return rows.map(r => ({
    id: r.id,
    title: r.title,
    sortTitle: r.title_sort || r.title,
    originalTitle: r.original_title || '',
    year: r.year || 0,
    edition: r.edition_title || '',
    summary: r.summary || '',
    contentRating: r.content_rating || '',
    rating: r.rating ?? null,
    duration: r.duration || 0,
    fileDuration: r.file_duration,
    libraryId,
  }));
}

// ── Markers ────────────────────────────────────────────────────────

/**
 * Get all markers for a specific metadata item (episode or movie).
 */
export function getMarkers(db: SafeDB, metadataId: number): Marker[] {
  const tagId = getMarkerTagId(db);
  if (!tagId) return [];

  const item = db.get<{ library_section_id: number }>(
    'SELECT library_section_id FROM metadata_items WHERE id = ?',
    metadataId
  );
  if (!item) return [];

  return getMarkersRaw(db, tagId, metadataId, item.library_section_id);
}

/**
 * Get markers with known tag ID and section ID (avoids extra lookups).
 */
export function getMarkersRaw(
  db: SafeDB, tagId: number, metadataId: number, sectionId: number
): Marker[] {
  const rows = db.all<{
    id: number; metadata_item_id: number; idx: number; text: string;
    time_offset: number; end_time_offset: number; created_at: number; extra_data: string;
  }>(
    `SELECT id, metadata_item_id, \`index\` as idx, text, time_offset,
            end_time_offset, created_at, extra_data
     FROM taggings
     WHERE metadata_item_id = ? AND tag_id = ?
     ORDER BY time_offset`,
    metadataId, tagId
  );

  return rows.map(r => rawToMarker(r, sectionId));
}

/**
 * Get all markers across multiple metadata items at once.
 */
export function getMarkersForItems(
  db: SafeDB, tagId: number, metadataIds: number[], sectionId: number
): Marker[] {
  if (metadataIds.length === 0) return [];

  const placeholders = metadataIds.map(() => '?').join(',');
  const rows = db.all<{
    id: number; metadata_item_id: number; idx: number; text: string;
    time_offset: number; end_time_offset: number; created_at: number; extra_data: string;
  }>(
    `SELECT id, metadata_item_id, \`index\` as idx, text, time_offset,
            end_time_offset, created_at, extra_data
     FROM taggings
     WHERE metadata_item_id IN (${placeholders}) AND tag_id = ?
     ORDER BY metadata_item_id, time_offset`,
    ...metadataIds, tagId
  );

  return rows.map(r => rawToMarker(r, sectionId));
}

/**
 * Get all episode IDs under a show or season (for bulk operations).
 */
export function getEpisodeIds(db: SafeDB, metadataId: number): number[] {
  // Determine if this is a show or season
  const item = db.get<{ metadata_type: number }>(
    'SELECT metadata_type FROM metadata_items WHERE id = ?',
    metadataId
  );
  if (!item) return [];

  if (item.metadata_type === PlexMetadataType.Episode) {
    return [metadataId];
  }

  if (item.metadata_type === PlexMetadataType.Season) {
    return db.all<{ id: number }>(
      `SELECT id FROM metadata_items WHERE parent_id = ? AND metadata_type = ? ORDER BY \`index\``,
      metadataId, PlexMetadataType.Episode
    ).map(r => r.id);
  }

  if (item.metadata_type === PlexMetadataType.Show) {
    return db.all<{ id: number }>(
      `SELECT e.id FROM metadata_items e
       JOIN metadata_items s ON e.parent_id = s.id AND s.metadata_type = ?
       WHERE s.parent_id = ? AND e.metadata_type = ?
       ORDER BY s.\`index\`, e.\`index\``,
      PlexMetadataType.Season, metadataId, PlexMetadataType.Episode
    ).map(r => r.id);
  }

  return [];
}

// ── Marker Summary ────────────────────────────────────────────────

export interface MarkerSummaryEntry {
  type: string;
  start: number;
  end: number;
}

/**
 * Get a lightweight summary of markers for each item.
 * Returns type, start, and end for each marker — enough to render
 * proportional colored regions in the sidebar without full marker data.
 */
export function getMarkerSummary(
  db: SafeDB, tagId: number, metadataIds: number[],
): Map<number, MarkerSummaryEntry[]> {
  if (metadataIds.length === 0) return new Map();

  const placeholders = metadataIds.map(() => '?').join(',');
  const rows = db.all<{ metadata_item_id: number; text: string; time_offset: number; end_time_offset: number }>(
    `SELECT metadata_item_id, text, time_offset, end_time_offset
     FROM taggings
     WHERE metadata_item_id IN (${placeholders}) AND tag_id = ?
     ORDER BY metadata_item_id, time_offset`,
    ...metadataIds, tagId
  );

  const result = new Map<number, MarkerSummaryEntry[]>();
  for (const row of rows) {
    const entries = result.get(row.metadata_item_id) || [];
    entries.push({ type: row.text, start: row.time_offset, end: row.end_time_offset });
    result.set(row.metadata_item_id, entries);
  }
  return result;
}

// ── Multi-Episode Siblings ────────────────────────────────────────

/**
 * Find all episode metadata_item_ids that share the same physical media file
 * as the given episode. Returns an array including the given ID itself.
 * For standalone episodes, returns just [metadataId].
 */
export function getSiblingEpisodeIds(db: SafeDB, metadataId: number): number[] {
  const filePath = db.get<{ file: string }>(
    `SELECT mp.file
     FROM media_items mi
     JOIN media_parts mp ON mp.media_item_id = mi.id
     WHERE mi.metadata_item_id = ?
     LIMIT 1`,
    metadataId
  );
  if (!filePath?.file) return [metadataId];

  const siblings = db.all<{ metadata_item_id: number }>(
    `SELECT DISTINCT mi.metadata_item_id
     FROM media_items mi
     JOIN media_parts mp ON mp.media_item_id = mi.id
     WHERE mp.file = ?`,
    filePath.file
  );

  return siblings.length > 0 ? siblings.map(r => r.metadata_item_id) : [metadataId];
}

// ── Media Info ─────────────────────────────────────────────────────

/**
 * Get media file information for a metadata item (episode or movie).
 * Joins metadata_items → media_items → media_parts to find the actual file path.
 */
export function getMediaInfo(db: SafeDB, metadataId: number): MediaInfo | null {
  const row = db.get<{
    part_id: number;
    file: string;
    container: string;
    width: number;
    height: number;
    video_codec: string;
    audio_codec: string;
    size: number;
    media_item_id: number;
  }>(
    `SELECT mp.id as part_id, mp.file, mi.container, mi.width, mi.height,
            mi.video_codec, mi.audio_codec, mp.size, mi.id as media_item_id
     FROM media_items mi
     JOIN media_parts mp ON mp.media_item_id = mi.id
     WHERE mi.metadata_item_id = ?
     ORDER BY mi.id ASC
     LIMIT 1`,
    metadataId
  );

  if (!row || !row.file) return null;

  // Calculate start offset for multi-episode files.
  // When multiple episodes share the same media file, Plex creates separate
  // media_items rows for each. The offset is the sum of metadata_items.duration
  // for all preceding episodes that share the same file.
  let startOffset = 0;
  const siblingEpisodes = db.all<{ metadata_item_id: number; ep_duration: number }>(
    `SELECT mi2.metadata_item_id, meta.duration as ep_duration
     FROM media_items mi2
     JOIN media_parts mp2 ON mp2.media_item_id = mi2.id
     JOIN metadata_items meta ON meta.id = mi2.metadata_item_id
     WHERE mp2.file = ? AND mi2.id < ?
     ORDER BY mi2.id ASC`,
    row.file, row.media_item_id
  );
  for (const sib of siblingEpisodes) {
    startOffset += sib.ep_duration || 0;
  }

  return {
    filePath: row.file,
    container: row.container || '',
    videoCodec: row.video_codec || '',
    audioCodec: row.audio_codec || '',
    width: row.width || 0,
    height: row.height || 0,
    frameRate: null,
    partId: row.part_id,
    fileSize: row.size || 0,
    startOffset,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

function rawToMarker(row: {
  id: number; metadata_item_id: number; idx: number; text: string;
  time_offset: number; end_time_offset: number; created_at: number; extra_data: string;
}, sectionId: number): Marker {
  return {
    id: row.id,
    parentId: row.metadata_item_id,
    sectionId,
    index: row.idx,
    type: row.text as Marker['type'],
    start: row.time_offset,
    end: row.end_time_offset,
    isFinal: ExtraData.isFinal(row.extra_data),
    createdAt: row.created_at,
    extraData: row.extra_data || '',
  };
}
