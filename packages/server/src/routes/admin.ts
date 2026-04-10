import { Router } from 'express';
import type { AppConfig } from '../config.js';
import type { AuthUser } from '@plex-meta-editor/shared';
import {
  getAllowedUsers,
  addAllowedUser,
  removeAllowedUser,
  isPlexHomeAllowed,
  setPlexHomeAllowed,
} from '../auth/allowed-users.js';
import { getPlexHomeUsers, getPlexFriends, validatePlexAccount } from '../auth/plex-oauth.js';

/**
 * Admin routes — only accessible by the server owner.
 * Mounted at /api/admin.
 */
export function createAdminRoutes(config: AppConfig) {
  const router = Router();

  // Middleware: require owner
  router.use((_req, res, next) => {
    const user = res.locals.user as AuthUser | undefined;
    if (!user?.isOwner) {
      res.status(403).json({ success: false, error: 'Owner access required' });
      return;
    }
    next();
  });

  // GET /api/admin/allowed-users — list all allowed users + settings
  router.get('/allowed-users', (_req, res) => {
    res.json({
      success: true,
      data: {
        entries: getAllowedUsers(),
        plexHomeAllowed: isPlexHomeAllowed(),
      },
    });
  });

  // POST /api/admin/allowed-users — add an allowed user
  router.post('/allowed-users', (req, res) => {
    const { value, label, source, thumb } = req.body as {
      value?: string;
      label?: string;
      source?: 'manual' | 'plex-home';
      thumb?: string;
    };

    if (!value || typeof value !== 'string' || !value.trim()) {
      res.status(400).json({ success: false, error: 'A username or email is required' });
      return;
    }

    const entries = addAllowedUser(value, label || '', source || 'manual', thumb);
    res.json({
      success: true,
      data: { entries, plexHomeAllowed: isPlexHomeAllowed() },
    });
  });

  // DELETE /api/admin/allowed-users/:value — remove an allowed user
  router.delete('/allowed-users/:value', (req, res) => {
    const { value } = req.params;
    const entries = removeAllowedUser(decodeURIComponent(value));
    res.json({
      success: true,
      data: { entries, plexHomeAllowed: isPlexHomeAllowed() },
    });
  });

  // PUT /api/admin/plex-home-allowed — toggle the "allow all Plex Home users" setting
  router.put('/plex-home-allowed', (req, res) => {
    const { allowed } = req.body as { allowed?: boolean };
    if (typeof allowed !== 'boolean') {
      res.status(400).json({ success: false, error: '"allowed" boolean is required' });
      return;
    }

    setPlexHomeAllowed(allowed);
    res.json({
      success: true,
      data: { entries: getAllowedUsers(), plexHomeAllowed: isPlexHomeAllowed() },
    });
  });

  // GET /api/admin/plex-home-users — fetch users from the Plex Home
  router.get('/plex-home-users', async (_req, res, next) => {
    if (!config.plexToken) {
      res.status(503).json({
        success: false,
        error: 'Plex token not available — cannot fetch home users',
      });
      return;
    }

    try {
      const raw = await getPlexHomeUsers(config.plexToken);
      // Map to the public shape (strip internal admin/restricted/guest fields)
      const users = raw.map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        thumb: u.thumb,
        friendlyName: u.friendlyName,
      }));
      res.json({ success: true, data: users });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/admin/validate-plex-user — look up a username/email
  // 1. Check Plex Home users (full profile available)
  // 2. Check Plex friends (full profile available)
  // 3. Probe the Plex registration endpoint (existence check only, no side effects)
  router.post('/validate-plex-user', async (req, res, next) => {
    const { query } = req.body as { query?: string };
    if (!query || typeof query !== 'string' || !query.trim()) {
      res.status(400).json({ success: false, error: 'A username or email is required' });
      return;
    }

    try {
      const needle = query.trim().toLowerCase();

      if (config.plexToken) {
        // Check Plex Home users first (full profile)
        const homeUsers = await getPlexHomeUsers(config.plexToken);
        for (const u of homeUsers) {
          if (u.username.toLowerCase() === needle || u.email.toLowerCase() === needle) {
            res.json({
              success: true,
              data: { found: true, id: u.id, username: u.username, email: u.email, thumb: u.thumb },
            });
            return;
          }
        }

        // Then check Plex friends (full profile)
        const friends = await getPlexFriends(config.plexToken);
        for (const f of friends) {
          if (f.username.toLowerCase() === needle || f.email.toLowerCase() === needle) {
            res.json({
              success: true,
              data: { found: true, id: f.id, username: f.username, email: f.email, thumb: f.thumb },
            });
            return;
          }
        }
      }

      // Fall back to registration probe — validates any Plex account exists,
      // but can only confirm existence (no profile data available)
      const probe = await validatePlexAccount(needle);
      if (probe.exists) {
        res.json({
          success: true,
          data: { found: true },
        });
        return;
      }

      res.json({ success: true, data: { found: false } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
