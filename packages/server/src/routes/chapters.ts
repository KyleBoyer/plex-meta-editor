/**
 * API routes for chapter management.
 *
 * Chapters are stored in media_parts.extra_data under the pv:chapters key.
 * All writes go through the safety pipeline (backup, integrity check).
 */

import { Router } from 'express';
import { z } from 'zod';
import type { SafeDB } from '../db/connection.js';
import type { AppConfig } from '../config.js';
import type { SafetyPipelineState } from '../safety/pipeline.js';
import { validateBody } from '../middleware/validate.js';
import { getChapters, getMediaPartForMetadata, getChapterSummary } from '../plex/chapters.js';
import { getEpisodeIds } from '../plex/queries.js';
import { buildSetChaptersStatements, buildClearChaptersStatements } from '../plex/chapter-mutations.js';

const setChaptersSchema = z.object({
  chapters: z.array(z.object({
    name: z.string().default(''),
    start: z.number().nonnegative(),
    end: z.number().positive(),
  })).min(0),
});

export function createChapterRoutes(db: SafeDB, _config: AppConfig, pipeline: SafetyPipelineState): Router {
  const router = Router();

  // GET /api/chapters/:metadataId
  router.get('/:metadataId', (req, res, next) => {
    try {
      const metadataId = parseInt(req.params.metadataId as string, 10);
      if (isNaN(metadataId) || metadataId <= 0) {
        res.status(400).json({ success: false, error: 'Invalid metadata ID' });
        return;
      }

      const chapterData = getChapters(db, metadataId);
      if (!chapterData) {
        res.json({ success: true, data: { chapters: [] } });
        return;
      }

      res.json({ success: true, data: chapterData });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/chapters/:metadataId
  router.put('/:metadataId', validateBody(setChaptersSchema), async (req, res, next) => {
    try {
      const metadataId = parseInt(req.params.metadataId as string, 10);
      if (isNaN(metadataId) || metadataId <= 0) {
        res.status(400).json({ success: false, error: 'Invalid metadata ID' });
        return;
      }

      const { chapters } = req.body;

      for (let i = 0; i < chapters.length; i++) {
        if (chapters[i].start >= chapters[i].end) {
          res.status(400).json({
            success: false,
            error: `Chapter ${i + 1}: start time must be less than end time`,
          });
          return;
        }
      }

      const mediaPart = getMediaPartForMetadata(db, metadataId);
      if (!mediaPart) {
        res.status(404).json({ success: false, error: 'No media file found for this item' });
        return;
      }

      const statements = buildSetChaptersStatements(mediaPart.partId, chapters, mediaPart.extraData);

      const result = await pipeline.execute(
        db, statements, 'edit',
        `Set ${chapters.length} chapter(s) on media part ${mediaPart.partId} (item ${metadataId})`
      );

      if (!result.success) {
        res.status(result.statusCode ?? 500).json({ success: false, error: result.error });
        return;
      }

      const updated = getChapters(db, metadataId);
      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/chapters/:metadataId
  router.delete('/:metadataId', async (req, res, next) => {
    try {
      const metadataId = parseInt(req.params.metadataId as string, 10);
      if (isNaN(metadataId) || metadataId <= 0) {
        res.status(400).json({ success: false, error: 'Invalid metadata ID' });
        return;
      }

      const mediaPart = getMediaPartForMetadata(db, metadataId);
      if (!mediaPart) {
        res.status(404).json({ success: false, error: 'No media file found for this item' });
        return;
      }

      const statements = buildClearChaptersStatements(mediaPart.partId, mediaPart.extraData);

      const result = await pipeline.execute(
        db, statements, 'delete',
        `Clear chapters on media part ${mediaPart.partId} (item ${metadataId})`
      );

      if (!result.success) {
        res.status(result.statusCode ?? 500).json({ success: false, error: result.error });
        return;
      }

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/chapters/summary/season/:seasonId — chapter boundaries for all episodes in a season
  router.get('/summary/season/:seasonId', (req, res, next) => {
    try {
      const seasonId = parseInt(req.params.seasonId as string, 10);
      const episodeIds = getEpisodeIds(db, seasonId);
      const summary = getChapterSummary(db, episodeIds);
      const data: Record<string, number[]> = {};
      for (const [id, positions] of summary) {
        data[id] = positions;
      }
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/chapters/summary/library/:libraryId — chapter boundaries for all movies in a library
  router.get('/summary/library/:libraryId', (req, res, next) => {
    try {
      const libraryId = parseInt(req.params.libraryId as string, 10);
      const movieIds = db.all<{ id: number }>(
        'SELECT id FROM metadata_items WHERE library_section_id = ? AND metadata_type = 1 ORDER BY title_sort',
        libraryId
      ).map(r => r.id);
      const summary = getChapterSummary(db, movieIds);
      const data: Record<string, number[]> = {};
      for (const [id, positions] of summary) {
        data[id] = positions;
      }
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
