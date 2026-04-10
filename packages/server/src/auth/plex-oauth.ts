import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PLEX_TV_API = 'https://plex.tv/api/v2';
const CLIENT_PRODUCT = 'Plex Meta Editor';

// Plex requires a stable UUID as the client identifier.
// Generate once and persist so returning users keep the same device identity.
function getClientId(): string {
  const stateDir = path.join(import.meta.dirname, '..', '..', '.state');
  const idFile = path.join(stateDir, 'client-id');
  try {
    const existing = fs.readFileSync(idFile, 'utf8').trim();
    if (existing) return existing;
  } catch { /* doesn't exist yet */ }
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(idFile, id, 'utf8');
  } catch { /* non-fatal */ }
  return id;
}

const CLIENT_ID = getClientId();

interface PlexPin {
  id: number;
  code: string;
  authToken: string | null;
}

interface PlexUser {
  id: number;
  username: string;
  email: string;
  thumb: string;
}

function plexHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'X-Plex-Client-Identifier': CLIENT_ID,
    'X-Plex-Product': CLIENT_PRODUCT,
  };
}

/**
 * Create a new Plex PIN for the OAuth flow.
 * POST https://plex.tv/api/v2/pins
 */
export async function createPin(): Promise<PlexPin> {
  const res = await fetch(`${PLEX_TV_API}/pins`, {
    method: 'POST',
    headers: {
      ...plexHeaders(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'strong=true',
  });

  if (!res.ok) {
    throw new Error(`Failed to create Plex PIN: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as Record<string, unknown>;
  return {
    id: data.id as number,
    code: data.code as string,
    authToken: (data.authToken as string) || null,
  };
}

/**
 * Check whether the user has authorized a PIN.
 * GET https://plex.tv/api/v2/pins/{pinId}
 */
export async function checkPin(pinId: number): Promise<PlexPin> {
  const res = await fetch(`${PLEX_TV_API}/pins/${pinId}`, {
    method: 'GET',
    headers: plexHeaders(),
  });

  if (!res.ok) {
    throw new Error(`Failed to check Plex PIN: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as Record<string, unknown>;
  return {
    id: data.id as number,
    code: data.code as string,
    authToken: (data.authToken as string) || null,
  };
}

/**
 * Get the Plex user info from an auth token.
 * GET https://plex.tv/api/v2/user
 */
export async function getPlexUser(authToken: string): Promise<PlexUser> {
  const res = await fetch(`${PLEX_TV_API}/user`, {
    method: 'GET',
    headers: {
      ...plexHeaders(),
      'X-Plex-Token': authToken,
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to get Plex user: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as Record<string, unknown>;
  return {
    id: data.id as number,
    username: (data.username as string) || (data.title as string) || '',
    email: (data.email as string) || '',
    thumb: (data.thumb as string) || '',
  };
}

/**
 * Build the Plex OAuth URL that the user should open in their browser.
 * Includes full device context so Plex recognizes this as a popup OAuth flow
 * and auto-closes the window after authorization.
 */
export function getAuthUrl(pinId: number, code: string): string {
  const params = new URLSearchParams({
    clientID: CLIENT_ID,
    code,
    'context[device][product]': CLIENT_PRODUCT,
    'context[device][version]': 'Plex OAuth',
    'context[device][platform]': 'Web',
    'context[device][platformVersion]': '',
    'context[device][device]': '',
    'context[device][deviceName]': `Web (${CLIENT_PRODUCT})`,
    'context[device][model]': 'Plex OAuth',
    'context[device][screenResolution]': '1920x1080',
    'context[device][layout]': 'desktop',
  });
  return `https://app.plex.tv/auth#?${params.toString()}`;
}

interface PlexHomeUser {
  id: number;
  username: string;
  email: string;
  thumb: string;
  friendlyName: string;
  /** True for the server owner in the home list */
  admin: boolean;
  /** True for restricted/managed profiles (e.g. Kids, Guest) */
  restricted: boolean;
  /** True for the built-in guest account */
  guest: boolean;
}

/**
 * Fetch the users in the server owner's Plex Home.
 * Uses the server's Plex token (not the logged-in user's token).
 * GET https://plex.tv/api/v2/home/users
 *
 * The response is `{ id, name, users: [...] }` — not a bare array.
 * We filter out the owner (admin: true) and guest/restricted managed users
 * that don't have a real Plex account (username is null).
 */
export async function getPlexHomeUsers(serverToken: string): Promise<PlexHomeUser[]> {
  const res = await fetch(`${PLEX_TV_API}/home/users`, {
    method: 'GET',
    headers: {
      ...plexHeaders(),
      'X-Plex-Token': serverToken,
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Plex Home users: ${res.status} ${res.statusText}`);
  }

  const body = await res.json() as Record<string, unknown>;

  // The response is { id, name, users: [...] }
  const rawUsers = body.users;
  if (!Array.isArray(rawUsers)) {
    return [];
  }

  return rawUsers
    .filter((u): u is Record<string, unknown> => u !== null && typeof u === 'object')
    .map((u) => ({
      id: (u.id as number) || 0,
      username: (u.username as string) || '',
      email: (u.email as string) || '',
      thumb: (u.thumb as string) || '',
      friendlyName: (u.friendlyName as string) || (u.title as string) || '',
      admin: !!(u.admin),
      restricted: !!(u.restricted),
      guest: !!(u.guest),
    }))
    // Filter out the owner (they always have access) and managed profiles
    // without a real Plex account (username is null/empty = managed user)
    .filter((u) => !u.admin && !u.guest && (u.username || u.email));
}

/**
 * Fetch the server owner's Plex friends (shared-with users).
 * GET https://plex.tv/api/v2/friends
 *
 * The response IS a bare array of friend objects.
 */
export async function getPlexFriends(serverToken: string): Promise<PlexHomeUser[]> {
  const res = await fetch(`${PLEX_TV_API}/friends`, {
    method: 'GET',
    headers: {
      ...plexHeaders(),
      'X-Plex-Token': serverToken,
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Plex friends: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as unknown[];
  if (!Array.isArray(data)) {
    return [];
  }

  return data
    .filter((u): u is Record<string, unknown> => u !== null && typeof u === 'object')
    .map((u) => ({
      id: (u.id as number) || 0,
      username: (u.username as string) || '',
      email: (u.email as string) || '',
      thumb: (u.thumb as string) || '',
      friendlyName: (u.friendlyName as string) || (u.title as string) || '',
      admin: false,
      restricted: !!(u.restricted),
      guest: false,
    }))
    .filter((u) => u.username || u.email);
}

/**
 * Validate whether a Plex username or email belongs to a real Plex account.
 *
 * Uses the account registration endpoint (`POST /api/v2/users`) with an
 * intentionally invalid password. The endpoint validates fields independently,
 * so we can check username/email existence without any side effects — no
 * account is created and no invites are sent.
 *
 * Error codes:
 *  - 1011 = "already been taken" → the account exists
 *  - 1037 = invalid characters
 *  - 1999 = generic pass (username/email is available, i.e. not taken)
 */
export async function validatePlexAccount(
  query: string,
): Promise<{ exists: boolean }> {
  const isEmail = query.includes('@');

  const body = isEmail
    ? { username: `_pme_probe_${Date.now()}`, email: query, password: 'x' }
    : { username: query, email: `_pme_probe_${Date.now()}@test.invalid`, password: 'x' };

  const res = await fetch(`${PLEX_TV_API}/users`, {
    method: 'POST',
    headers: {
      ...plexHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  // The request always fails (bad password at minimum), but we inspect field errors
  if (res.status === 422 || res.status === 400) {
    const data = await res.json() as { errors?: Array<{ code: number; field?: string }> };
    const errors = data.errors || [];
    const targetField = isEmail ? 'email' : 'username';
    const fieldError = errors.find((e) => e.field === targetField);

    if (fieldError?.code === 1011) {
      // "already been taken" → the account exists
      return { exists: true };
    }
    // 1999 (available) or 1037 (invalid chars) → doesn't exist or not valid
    return { exists: false };
  }

  // Unexpected response — assume not found
  return { exists: false };
}
