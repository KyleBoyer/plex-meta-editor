import type { AppConfig } from '../config.js';
import { isInAllowedList, isPlexHomeAllowed } from './allowed-users.js';
import { getPlexHomeUsers } from './plex-oauth.js';

/**
 * Fetch the server owner's myPlexUsername from the Plex server.
 * Note: This is often the owner's email address, not their display username.
 */
export async function getServerOwnerUsername(config: AppConfig): Promise<string | null> {
  if (!config.plexUrl || !config.plexToken) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const url = new URL('/', `${config.plexUrl}/`);
    url.searchParams.set('X-Plex-Token', config.plexToken);

    const res = await fetch(url, {
      headers: { Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8' },
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`Failed to get Plex server owner: ${res.status} ${res.statusText}`);
      return null;
    }

    const xml = await res.text();

    // Extract myPlexUsername from the XML using regex (no xml2js dependency)
    const match = /myPlexUsername="([^"]*)"/.exec(xml);
    return match ? match[1] : null;
  } catch (err) {
    console.warn(`Failed to get Plex server owner: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Plex Home users cache (5 min TTL) ──────────────────────────

interface PlexHomeCacheEntry {
  usernames: Set<string>;
  fetchedAt: number;
}

let plexHomeCache: PlexHomeCacheEntry | null = null;
const PLEX_HOME_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function isInPlexHome(username: string, email: string, config: AppConfig): Promise<boolean> {
  if (!config.plexToken) return false;

  // Refresh cache if stale
  if (!plexHomeCache || Date.now() - plexHomeCache.fetchedAt > PLEX_HOME_CACHE_TTL) {
    try {
      const homeUsers = await getPlexHomeUsers(config.plexToken);
      const names = new Set<string>();
      for (const u of homeUsers) {
        if (u.username) names.add(u.username.toLowerCase());
        if (u.email) names.add(u.email.toLowerCase());
      }
      plexHomeCache = { usernames: names, fetchedAt: Date.now() };
    } catch {
      // If fetch fails and we have stale cache, keep using it
      if (!plexHomeCache) return false;
    }
  }

  return plexHomeCache.usernames.has(username.toLowerCase()) ||
    plexHomeCache.usernames.has(email.toLowerCase());
}

/**
 * Check if a user is authorized to access this instance.
 *
 * Authorized if:
 * - The username OR email matches the server owner's myPlexUsername, OR
 * - The "allow all Plex Home users" toggle is on AND the user is in the Plex Home, OR
 * - The username is in the file-based allowed list, OR
 * - The username is listed in ALLOWED_USERS env var (comma-separated)
 *
 * The Plex server reports myPlexUsername which is typically the owner's email,
 * while the Plex user API returns a separate username field. We check both
 * to handle this mismatch.
 */
export async function isUserAuthorized(
  username: string,
  email: string,
  ownerMyPlexUsername: string | null,
  config: AppConfig,
): Promise<boolean> {
  if (ownerMyPlexUsername) {
    const ownerLower = ownerMyPlexUsername.toLowerCase();
    // The server's myPlexUsername might be the owner's email or their username
    if (username.toLowerCase() === ownerLower || email.toLowerCase() === ownerLower) {
      return true;
    }
  }

  // Check the "allow all Plex Home users" master toggle
  if (isPlexHomeAllowed()) {
    const inHome = await isInPlexHome(username, email, config);
    if (inHome) return true;
  }

  // Check file-based allowed users list
  if (isInAllowedList(username, email)) {
    return true;
  }

  // Check ALLOWED_USERS env var
  const allowedUsers = process.env.ALLOWED_USERS;
  if (allowedUsers) {
    const allowed = allowedUsers
      .split(',')
      .map((u) => u.trim().toLowerCase())
      .filter(Boolean);
    if (allowed.includes(username.toLowerCase()) || allowed.includes(email.toLowerCase())) {
      return true;
    }
  }

  return false;
}
