import { Router } from 'express';
import type { SafeDB } from '../db/connection.js';

export function createMovieRoutes(db: SafeDB): Router {
  const router = Router();

  // GET /api/movies/:id — movie detail with markers
  router.get('/:id', (req, res, next) => {
    try {
      const movieId = parseInt(req.params.id, 10);
      const movie = db.get<{
        id: number; title: string; title_sort: string; original_title: string;
        year: number; edition_title: string; duration: number; library_section_id: number;
        file_duration: number;
      }>(
        `SELECT mi.id, mi.title, mi.title_sort, mi.original_title, mi.year,
                mi.edition_title, mi.duration, mi.library_section_id,
                COALESCE((
                  SELECT MAX(mdi.duration)
                  FROM media_items mdi
                  WHERE mdi.metadata_item_id = mi.id
                ), 0) as file_duration
         FROM metadata_items mi
         WHERE mi.id = ? AND mi.metadata_type = 1`,
        movieId
      );

      if (!movie) {
        res.status(404).json({ success: false, error: 'Movie not found' });
        return;
      }

      // Get marker tag ID
      const markerTag = db.get<{ id: number }>(
        "SELECT id FROM tags WHERE tag_type = 12 LIMIT 1"
      );

      const markers = markerTag
        ? db.all<{
            id: number; idx: number; text: string; time_offset: number;
            end_time_offset: number; created_at: number; extra_data: string;
          }>(
            `SELECT id, \`index\` as idx, text, time_offset, end_time_offset, created_at, extra_data
             FROM taggings WHERE metadata_item_id = ? AND tag_id = ? ORDER BY time_offset`,
            movieId, markerTag.id
          )
        : [];

      res.json({
        success: true,
        data: {
          id: movie.id,
          title: movie.title,
          sortTitle: movie.title_sort || movie.title,
          originalTitle: movie.original_title || '',
          year: movie.year || 0,
          edition: movie.edition_title || '',
          duration: movie.duration || 0,
          fileDuration: movie.file_duration,
          libraryId: movie.library_section_id,
          markers: markers.map(m => ({
            id: m.id,
            parentId: movieId,
            sectionId: movie.library_section_id,
            index: m.idx,
            type: m.text,
            start: m.time_offset,
            end: m.end_time_offset,
            isFinal: m.extra_data ? m.extra_data.includes('"final"') || m.extra_data.includes('final=1') : false,
            createdAt: m.created_at,
            extraData: m.extra_data || '',
          })),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
