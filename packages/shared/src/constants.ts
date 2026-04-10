import { MarkerType } from './types/plex.js';

/** Valid marker type values */
export const MARKER_TYPES = Object.values(MarkerType);

/** The tag text value used in the Plex taggings table for markers */
export const MARKER_TAG_TEXT = 'marker';

/** Default server configuration */
export const DEFAULT_CONFIG = {
  port: 3232,
  host: 'localhost',
  backupDir: 'backups',
  /** Maximum number of backups to retain */
  maxBackups: 50,
  /** Busy timeout for SQLite in milliseconds */
  busyTimeout: 5000,
} as const;

/** Extra data format for markers in the Plex DB */
export const ExtraData = {
  /** Build the extra_data JSON for a marker */
  build(type: MarkerType, isFinal: boolean): string {
    const data: Record<string, unknown> = {
      pv_version: '5',
      pv_type: type,
    };
    if (type === MarkerType.Credits && isFinal) {
      data.final = true;
    }
    return JSON.stringify(data);
  },

  /** Parse extra_data to determine if a marker is "final" */
  isFinal(extraData: string): boolean {
    if (!extraData) return false;
    try {
      const parsed = JSON.parse(extraData);
      return !!parsed.final;
    } catch {
      // Legacy URL-encoded format
      return extraData.includes('final=1');
    }
  },
} as const;
