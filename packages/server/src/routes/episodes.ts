import { Router } from 'express';
import { z } from 'zod';
import type { SafeDB } from '../db/connection.js';
import type { AppConfig } from '../config.js';
import type { SafetyPipelineState } from '../safety/pipeline.js';
import { validateBody } from '../middleware/validate.js';

const updateDurationSchema = z.object({
  duration: z.number().int().positive(),
});

export function createEpisodeRoutes(db: SafeDB, config: AppConfig, pipeline: SafetyPipelineState): Router {
  const router = Router();

  // GET /api/episodes/:id — episode detail with markers
  router.get('/:id', (req, res, next) => {
    try {
      const episodeId = parseInt(req.params.id as string, 10);

      const episode = db.get<{
        id: number; title: string; idx: number; duration: number;
        season_id: number; season_index: number; season_title: string;
        show_id: number; show_title: string; library_section_id: number;
      }>(
        `SELECT e.id, e.title, e.\`index\` as idx, e.duration,
                s.id as season_id, s.\`index\` as season_index, s.title as season_title,
                sh.id as show_id, sh.title as show_title, e.library_section_id
         FROM metadata_items e
         JOIN metadata_items s ON e.parent_id = s.id AND s.metadata_type = 3
         JOIN metadata_items sh ON s.parent_id = sh.id AND sh.metadata_type = 2
         WHERE e.id = ? AND e.metadata_type = 4`,
        episodeId
      );

      if (!episode) {
        res.status(404).json({ success: false, error: 'Episode not found' });
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
            episodeId, markerTag.id
          )
        : [];

      res.json({
        success: true,
        data: {
          id: episode.id,
          title: episode.title,
          showId: episode.show_id,
          showTitle: episode.show_title,
          seasonId: episode.season_id,
          seasonIndex: episode.season_index,
          index: episode.idx,
          duration: episode.duration || 0,
          libraryId: episode.library_section_id,
          markers: markers.map(m => ({
            id: m.id,
            parentId: episodeId,
            sectionId: episode.library_section_id,
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

  // GET /api/episodes/season/:seasonId — all episodes of a season
  router.get('/season/:seasonId', (req, res, next) => {
    try {
      const seasonId = parseInt(req.params.seasonId, 10);

      const season = db.get<{
        id: number; title: string; idx: number; show_id: number; show_title: string;
      }>(
        `SELECT s.id, s.title, s.\`index\` as idx,
                sh.id as show_id, sh.title as show_title
         FROM metadata_items s
         JOIN metadata_items sh ON s.parent_id = sh.id AND sh.metadata_type = 2
         WHERE s.id = ? AND s.metadata_type = 3`,
        seasonId
      );

      if (!season) {
        res.status(404).json({ success: false, error: 'Season not found' });
        return;
      }

      const rows = db.all<{
        id: number; title: string; idx: number; duration: number; library_section_id: number; media_file_path: string; file_duration: number;
      }>(
        `SELECT e.id, e.title, e.\`index\` as idx, e.duration, e.library_section_id,
                COALESCE(mp.file, '') as media_file_path,
                COALESCE(mi.duration, 0) as file_duration
         FROM metadata_items e
         LEFT JOIN media_items mi ON mi.metadata_item_id = e.id
         LEFT JOIN media_parts mp ON mp.media_item_id = mi.id
         WHERE e.parent_id = ? AND e.metadata_type = 4
         ORDER BY e.\`index\``,
        seasonId
      );

      const episodes = rows.map(row => ({
        id: row.id,
        title: row.title,
        showId: season.show_id,
        showTitle: season.show_title,
        seasonId,
        seasonIndex: season.idx,
        index: row.idx,
        duration: row.duration || 0,
        libraryId: row.library_section_id,
        mediaFilePath: row.media_file_path,
        fileDuration: row.file_duration,
      }));

      res.json({ success: true, data: episodes });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/episodes/:id/duration — update an episode's duration (for adjusting multi-episode boundaries)
  router.put('/:id/duration', validateBody(updateDurationSchema), async (req, res, next) => {
    try {
      const episodeId = parseInt(req.params.id as string, 10);
      const { duration } = req.body;

      // Verify episode exists
      const episode = db.get<{ id: number; duration: number }>(
        'SELECT id, duration FROM metadata_items WHERE id = ? AND metadata_type = 4',
        episodeId
      );
      if (!episode) {
        res.status(404).json({ success: false, error: 'Episode not found' });
        return;
      }

      const statements = [
        { sql: 'UPDATE metadata_items SET duration = ? WHERE id = ?', params: [duration, episodeId] as unknown[] },
      ];

      const result = await pipeline.execute(
        db, statements, 'edit',
        `Update duration of episode ${episodeId} from ${episode.duration}ms to ${duration}ms`
      );

      if (!result.success) {
        res.status(result.statusCode ?? 500).json({ success: false, error: result.error });
        return;
      }

      res.json({ success: true, data: { id: episodeId, duration } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
