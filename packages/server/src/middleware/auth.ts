import type { Request, Response, NextFunction } from 'express';
import type { AuthUser, AuthSession } from '@plex-meta-editor/shared';
import crypto from 'node:crypto';

// ── In-memory session store ──────────────────────────────────────

const sessions = new Map<string, AuthSession>();
const SESSION_COOKIE = 'pme_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Create a new session for an authenticated user.
 * Returns the session ID (to be stored in a cookie).
 */
export function createSession(user: AuthUser): string {
  const sessionId = crypto.randomBytes(32).toString('hex');
  const session: AuthSession = {
    user,
    expiresAt: Date.now() + SESSION_MAX_AGE,
  };
  sessions.set(sessionId, session);
  return sessionId;
}

/**
 * Look up a session by ID. Returns null if expired or missing.
 */
export function getSession(sessionId: string): AuthSession | null {
  const session = sessions.get(sessionId);
  if (!session) return null;

  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return null;
  }

  return session;
}

/**
 * Destroy (remove) a session.
 */
export function destroySession(sessionId: string): void {
  sessions.delete(sessionId);
}

/**
 * Parse a raw Cookie header into key-value pairs.
 */
export function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  for (const pair of cookieHeader.split(';')) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;
    const key = pair.slice(0, eqIndex).trim();
    const value = pair.slice(eqIndex + 1).trim();
    if (key) {
      cookies[key] = decodeURIComponent(value);
    }
  }
  return cookies;
}

/**
 * Express middleware: require a valid session.
 * Attaches the user to `res.locals.user` on success.
 * Returns 401 if unauthenticated.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const cookies = parseCookies(req.headers.cookie || '');
  const sessionId = cookies[SESSION_COOKIE];

  if (!sessionId) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    res.status(401).json({ success: false, error: 'Session expired or invalid' });
    return;
  }

  res.locals.user = session.user;
  next();
}

/**
 * Set the session cookie on a response.
 */
export function setSessionCookie(res: Response, sessionId: string): void {
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE}=${sessionId}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${Math.floor(SESSION_MAX_AGE / 1000)}`,
  ].join('; '));
}

/**
 * Clear the session cookie on a response.
 */
export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE}=`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=0`,
  ].join('; '));
}
