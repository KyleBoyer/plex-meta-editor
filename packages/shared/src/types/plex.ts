// Plex database schema types

/** Plex library section */
export interface Library {
  id: number;
  name: string;
  type: SectionType;
  uuid: string;
}

/** Library section types in Plex */
export enum SectionType {
  Movie = 1,
  TV = 2,
}

/** Plex metadata_items.metadata_type values */
export enum MetadataType {
  Movie = 1,
  Show = 2,
  Season = 3,
  Episode = 4,
}

/** Base type for all Plex metadata items */
export interface PlexItem {
  id: number;
  title: string;
  libraryId: number;
}

/** TV Show */
export interface Show extends PlexItem {
  sortTitle: string;
  originalTitle: string;
  seasonCount: number;
  episodeCount: number;
  year: number;
  summary: string;
  contentRating: string;
  rating: number | null;
  genres: string;
  studio: string;
}

/** Season of a TV show */
export interface Season extends PlexItem {
  showId: number;
  showTitle: string;
  index: number;
  episodeCount: number;
}

/** Episode of a TV show */
export interface Episode extends PlexItem {
  showId: number;
  showTitle: string;
  seasonId: number;
  seasonIndex: number;
  index: number;
  duration: number; // milliseconds
  /** Media file path — episodes sharing a file have the same value. Empty if no media. */
  mediaFilePath: string;
  /** Actual media file duration in ms (from media_items, not metadata_items). 0 if unknown. */
  fileDuration: number;
}

/** Movie */
export interface Movie extends PlexItem {
  sortTitle: string;
  originalTitle: string;
  year: number;
  edition: string;
  summary: string;
  contentRating: string;
  rating: number | null;
  duration: number; // milliseconds (from metadata_items — can be inaccurate)
  /** Actual media file duration in ms (from media_items, not metadata_items). 0 if unknown. */
  fileDuration: number;
}

/** Base shape for cross-library search results shown in the sidebar */
export interface LibrarySearchResultBase extends PlexItem {
  kind: 'show' | 'movie';
  libraryName: string;
  libraryType: SectionType;
  sortTitle: string;
  originalTitle: string;
}

/** Cross-library TV show search result */
export interface ShowSearchResult extends LibrarySearchResultBase {
  kind: 'show';
  seasonCount: number;
  episodeCount: number;
}

/** Cross-library movie search result */
export interface MovieSearchResult extends LibrarySearchResultBase {
  kind: 'movie';
  year: number;
  edition: string;
  duration: number; // milliseconds (from metadata_items — can be inaccurate)
  /** Actual media file duration in ms (from media_items, not metadata_items). 0 if unknown. */
  fileDuration: number;
}

/** Mixed show/movie search result for the sidebar */
export type LibrarySearchResult = ShowSearchResult | MovieSearchResult;

/** Marker types in Plex */
export enum MarkerType {
  Intro = 'intro',
  Credits = 'credits',
  Commercial = 'commercial',
}

/** A marker (intro/credits/commercial skip) attached to an episode or movie */
export interface Marker {
  id: number;
  /** metadata_item_id — the episode or movie this marker belongs to */
  parentId: number;
  /** The library section ID */
  sectionId: number;
  /** Index of this marker among the parent's markers (sorted by start time) */
  index: number;
  /** Marker type */
  type: MarkerType;
  /** Start time in milliseconds */
  start: number;
  /** End time in milliseconds */
  end: number;
  /** Whether this credits marker extends to the end of the media */
  isFinal: boolean;
  /** Unix timestamp when created */
  createdAt: number;
  /** Extra data JSON string */
  extraData: string;
}

/** Data needed to create a new marker */
export interface NewMarker {
  parentId: number;
  type: MarkerType;
  start: number;
  end: number;
  isFinal: boolean;
}

/** Data needed to update an existing marker */
export interface UpdateMarker {
  id: number;
  type: MarkerType;
  start: number;
  end: number;
  isFinal: boolean;
}

/** Episode with its markers */
export interface EpisodeWithMarkers extends Episode {
  markers: Marker[];
}

/** Movie with its markers */
export interface MovieWithMarkers extends Movie {
  markers: Marker[];
}

/** Information about the media file associated with an episode or movie */
export interface MediaInfo {
  /** Full local file path to the media file */
  filePath: string;
  /** Container format: mp4, mkv, avi, etc. */
  container: string;
  /** Video codec: h264, hevc, vp9, etc. */
  videoCodec: string;
  /** Audio codec: aac, ac3, dts, etc. */
  audioCodec: string;
  /** Video width in pixels */
  width: number;
  /** Video height in pixels */
  height: number;
  /** Video frame rate in frames per second when it could be detected */
  frameRate: number | null;
  /** Plex media_parts.id — needed for Plex API streaming mode */
  partId: number;
  /** File size in bytes */
  fileSize: number;
  /**
   * Start time offset in milliseconds within a shared media file.
   * For multi-episode files (e.g. S01E01-E02.mkv), Plex stores where each
   * episode begins within the file. 0 for standalone single-episode files.
   */
  startOffset: number;
}

// ── Chapters ──────────────────────────────────────────────────────

/** A chapter within a media part */
export interface Chapter {
  /** Chapter name (often empty string for auto-detected chapters) */
  name: string;
  /** Start time in milliseconds (converted from Plex's seconds-based storage) */
  start: number;
  /** End time in milliseconds (converted from Plex's seconds-based storage) */
  end: number;
}

/** Chapter data for a media item */
export interface ChapterData {
  /** Ordered list of chapters (sorted by start time) */
  chapters: Chapter[];
}

// ── Video Settings ────────────────────────────────────────────────

/** Video source mode for the player */
export type VideoSourceMode =
  | 'direct'
  | 'plex-api'
  | 'plex-transcode'
  | 'plex-transcode-full'
  | 'plex-transcode-safe';

/** User-configurable video settings */
export interface VideoSettings {
  mode: VideoSourceMode;
}

/**
 * Raw row from the taggings table in the Plex database.
 * This is the direct DB representation before we transform it into our Marker type.
 */
export interface RawTaggingRow {
  id: number;
  metadata_item_id: number;
  tag_id: number;
  index: number;
  text: string;
  time_offset: number;
  end_time_offset: number;
  thumb_url: string;
  created_at: number;
  extra_data: string;
}
