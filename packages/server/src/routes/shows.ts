import { Router } from 'express';
import type { SafeDB } from '../db/connection.js';

export function createShowRoutes(db: SafeDB): Router {
  const router = Router();

  // GET /api/shows/:id/seasons — seasons of a show
  router.get('/:id/seasons', (req, res, next) => {
    try {
      const showId = parseInt(req.params.id, 10);
      const show = db.get<{ title: string }>(
        'SELECT title FROM metadata_items WHERE id = ? AND metadata_type = 2',
        showId
      );

      if (!show) {
        res.status(404).json({ success: false, error: 'Show not found' });
        return;
      }

      const rows = db.all<{
        id: number; title: string; idx: number; episode_count: number;
      }>(
        `SELECT mi.id, mi.title, mi.\`index\` as idx,
                (SELECT COUNT(*) FROM metadata_items e WHERE e.parent_id = mi.id AND e.metadata_type = 4) as episode_count
         FROM metadata_items mi
         WHERE mi.parent_id = ? AND mi.metadata_type = 3
         ORDER BY mi.\`index\``,
        showId
      );

      const seasons = rows.map(row => ({
        id: row.id,
        title: row.title || `Season ${row.idx}`,
        showId,
        showTitle: show.title,
        index: row.idx,
        episodeCount: row.episode_count,
        libraryId: 0, // filled from parent if needed
      }));

      res.json({ success: true, data: seasons });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
