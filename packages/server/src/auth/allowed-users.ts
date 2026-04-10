import fs from 'node:fs';
import path from 'node:path';
import type { AllowedUserEntry } from '@plex-meta-editor/shared';

const STATE_DIR = path.join(import.meta.dirname, '..', '..', '.state');
const ALLOWED_USERS_FILE = path.join(STATE_DIR, 'allowed-users.json');

interface StoredData {
  entries: AllowedUserEntry[];
  plexHomeAllowed: boolean;
}

/** In-memory state, synced to disk on mutation. */
let entries: AllowedUserEntry[] = [];
let plexHomeAllowed = false;

/** Load the allowed users list from disk (call once at startup). */
export function loadAllowedUsers(): void {
  try {
    const raw = fs.readFileSync(ALLOWED_USERS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      plexHomeAllowed = !!parsed.plexHomeAllowed;
    } else if (Array.isArray(parsed)) {
      // Migrate from old array-only format
      entries = parsed;
      plexHomeAllowed = false;
    }
  } catch {
    entries = [];
    plexHomeAllowed = false;
  }
}

/** Persist the current state to disk. */
function save(): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const data: StoredData = { entries, plexHomeAllowed };
    fs.writeFileSync(ALLOWED_USERS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save allowed-users.json:', err);
  }
}

/** Get the current allowed users list. */
export function getAllowedUsers(): AllowedUserEntry[] {
  return entries;
}

/** Get whether all Plex Home users are allowed. */
export function isPlexHomeAllowed(): boolean {
  return plexHomeAllowed;
}

/** Set the Plex Home master toggle. */
export function setPlexHomeAllowed(allowed: boolean): void {
  plexHomeAllowed = allowed;
  save();
}

/** Add an entry. Returns the updated list. Deduplicates by lowercase value. */
export function addAllowedUser(
  value: string,
  label: string,
  source: 'manual' | 'plex-home',
  thumb?: string,
): AllowedUserEntry[] {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return entries;

  const existingIdx = entries.findIndex((e) => e.value === normalized);
  if (existingIdx >= 0) {
    // Update label/thumb if provided (e.g. re-adding after validation resolved more info)
    const existing = entries[existingIdx];
    if ((thumb && thumb !== existing.thumb) || (label && label !== existing.label)) {
      entries[existingIdx] = {
        ...existing,
        label: label || existing.label,
        thumb: thumb || existing.thumb,
      };
      save();
    }
  } else {
    entries.push({ value: normalized, label: label || normalized, source, thumb });
    save();
  }

  return entries;
}

/** Remove an entry by value (case-insensitive). Returns the updated list. */
export function removeAllowedUser(value: string): AllowedUserEntry[] {
  const normalized = value.trim().toLowerCase();
  entries = entries.filter((e) => e.value !== normalized);
  save();
  return entries;
}

/**
 * Check if a username or email is in the file-based allowed list.
 * This is separate from the ALLOWED_USERS env var check.
 */
export function isInAllowedList(username: string, email: string): boolean {
  const userLower = username.toLowerCase();
  const emailLower = email.toLowerCase();
  return entries.some((e) => e.value === userLower || e.value === emailLower);
}
