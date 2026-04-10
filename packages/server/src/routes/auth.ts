import { Router } from 'express';
import type { AppConfig } from '../config.js';
import type { AuthUser } from '@plex-meta-editor/shared';
import { createPin, checkPin, getPlexUser, getAuthUrl } from '../auth/plex-oauth.js';
import { getServerOwnerUsername, isUserAuthorized } from '../auth/permissions.js';
import {
  createSession,
  getSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
} from '../middleware/auth.js';

export function createAuthRoutes(config: AppConfig) {
  const router = Router();

  // Cache the owner username so we don't fetch it on every login
  let cachedOwnerUsername: string | null | undefined;

  async function resolveOwnerUsername(): Promise<string | null> {
    if (cachedOwnerUsername === undefined) {
      cachedOwnerUsername = await getServerOwnerUsername(config);
    }
    return cachedOwnerUsername;
  }

  // POST /api/auth/pin — Create a new Plex auth PIN
  router.post('/pin', async (_req, res) => {
    const pin = await createPin();
    const authUrl = getAuthUrl(pin.id, pin.code);
    res.json({ success: true, data: { id: pin.id, code: pin.code, authUrl } });
  });

  // GET /api/auth/pin/:id — Poll PIN status
  router.get('/pin/:id', async (req, res) => {
    const pinId = Number(req.params.id);
    if (!Number.isFinite(pinId) || pinId <= 0) {
      res.status(400).json({ success: false, error: 'Invalid pin ID' });
      return;
    }

    const pin = await checkPin(pinId);
    if (pin.authToken) {
      res.json({ success: true, data: { ready: true, token: pin.authToken } });
    } else {
      res.json({ success: true, data: { ready: false } });
    }
  });

  // POST /api/auth/login — Exchange Plex token for a session
  router.post('/login', async (req, res) => {
    const { token } = req.body as { token?: string };
    if (!token) {
      res.status(400).json({ success: false, error: 'Token required' });
      return;
    }

    // Get Plex user info
    const plexUser = await getPlexUser(token);

    // Check permissions
    const ownerUsername = await resolveOwnerUsername();
    const isOwner = ownerUsername
      ? plexUser.username.toLowerCase() === ownerUsername.toLowerCase() ||
        plexUser.email.toLowerCase() === ownerUsername.toLowerCase()
      : false;

    if (!(await isUserAuthorized(plexUser.username, plexUser.email, ownerUsername, config))) {
      res.status(403).json({
        success: false,
        error: 'You do not have permission to access this server.',
      });
      return;
    }

    const user: AuthUser = {
      id: plexUser.id,
      username: plexUser.username,
      email: plexUser.email,
      thumb: plexUser.thumb,
      isOwner,
    };

    const sessionId = createSession(user);
    setSessionCookie(res, sessionId);
    res.json({ success: true, data: user });
  });

  // POST /api/auth/logout
  router.post('/logout', (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const sessionId = cookies['pme_session'];
    if (sessionId) {
      destroySession(sessionId);
    }
    clearSessionCookie(res);
    res.json({ success: true });
  });

  // GET /api/auth/session — Check current session
  router.get('/session', (req, res) => {
    const cookies = parseCookies(req.headers.cookie || '');
    const sessionId = cookies['pme_session'];
    const session = sessionId ? getSession(sessionId) : null;
    res.json({ success: true, data: session });
  });

  return router;
}
