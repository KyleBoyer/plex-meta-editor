/**
 * Shared time formatting and parsing utilities.
 * Used by marker, chapter, and timeline components.
 */

/**
 * Format milliseconds as a timecode string with millisecond precision.
 * Output: "H:MM:SS.mmm" or "M:SS.mmm" (no hours prefix when h=0).
 */
export function formatTime(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const millis = Math.floor(ms % 1000);
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }
  return `${m}:${String(sec).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/**
 * Format milliseconds as a full timecode string, always including hours.
 * Output: "H:MM:SS.mmm"
 */
export function formatTimeFull(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const millis = Math.floor(ms % 1000);
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/**
 * Parse a timecode string into milliseconds.
 * Accepts: "H:MM:SS.mmm", "M:SS.mmm", or raw milliseconds as a number string.
 * Returns null if the input is invalid.
 */
export function parseTime(str: string): number | null {
  str = str.trim();
  const full = str.match(/^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (full) {
    return ((parseInt(full[1]) * 3600) + (parseInt(full[2]) * 60) + parseInt(full[3])) * 1000
      + (full[4] ? parseInt(full[4].padEnd(3, '0')) : 0);
  }
  const short = str.match(/^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (short) {
    return ((parseInt(short[1]) * 60) + parseInt(short[2])) * 1000
      + (short[3] ? parseInt(short[3].padEnd(3, '0')) : 0);
  }
  const num = parseInt(str);
  if (!isNaN(num) && num >= 0) return num;
  return null;
}
