/**
 * Plex database schema constants.
 * These correspond to the actual column names and table structure
 * of the Plex SQLite database (com.plexapp.plugins.library.db).
 */

/** Tag type for markers in the tags table */
export const MARKER_TAG_TYPE = 12;

/** Metadata types in metadata_items.metadata_type */
export const PlexMetadataType = {
  Movie: 1,
  Show: 2,
  Season: 3,
  Episode: 4,
} as const;

/** Base types that can have markers attached */
export const BASE_MARKER_TYPES = [PlexMetadataType.Movie, PlexMetadataType.Episode] as const;

/**
 * Look up the marker tag ID from the tags table.
 * In Plex, markers are stored as taggings linked to a special tag with tag_type=12.
 * Returns null if no marker tag exists (rare — means no markers have ever been created).
 */
export function getMarkerTagId(db: { get: <T>(sql: string, ...params: unknown[]) => T | undefined }): number | null {
  const row = db.get<{ id: number }>(
    `SELECT id FROM tags WHERE tag_type = ${MARKER_TAG_TYPE} LIMIT 1`
  );
  return row?.id ?? null;
}

/**
 * Ensure a marker tag exists, creating one if necessary.
 * This is needed when adding the very first marker to a Plex DB that has never had markers.
 */
export function ensureMarkerTag(db: {
  get: <T>(sql: string, ...params: unknown[]) => T | undefined;
  run: (sql: string, ...params: unknown[]) => { lastInsertRowid: number | bigint };
}): number {
  const existing = getMarkerTagId(db);
  if (existing !== null) return existing;

  // Create the marker tag — matches what Plex itself creates
  const result = db.run(
    `INSERT INTO tags (tag_type, tag_value) VALUES (?, ?)`,
    MARKER_TAG_TYPE, 'marker'
  );
  return Number(result.lastInsertRowid);
}
