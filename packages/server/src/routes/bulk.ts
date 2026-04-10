import { Router } from 'express';
import { z } from 'zod';
import type { SafeDB } from '../db/connection.js';
import type { AppConfig } from '../config.js';
import type { SafetyPipelineState } from '../safety/pipeline.js';
import { getMarkerTagId } from '../plex/schema.js';
import { getEpisodeIds } from '../plex/queries.js';
import {
  buildBulkAddStatements,
  buildBulkDeleteStatements,
  buildBulkShiftStatements,
} from '../plex/mutations.js';
import { validateBody } from '../middleware/validate.js';

const bulkAddSchema = z.object({
  metadataId: z.number().int().positive(),
  type: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  ignoredEpisodes: z.array(z.number().int()).default([]),
});

const bulkDeleteSchema = z.object({
  metadataId: z.number().int().positive(),
  markerType: z.string().nullable().default(null),
  ignoredMarkerIds: z.array(z.number().int()).default([]),
});

const bulkShiftSchema = z.object({
  metadataId: z.number().int().positive(),
  startShift: z.number().int(),
  endShift: z.number().int(),
  markerType: z.string().nullable().default(null),
  ignoredMarkerIds: z.array(z.number().int()).default([]),
});

export function createBulkRoutes(db: SafeDB, _config: AppConfig, pipeline: SafetyPipelineState): Router {
  const router = Router();

  // ── Bulk Add ─────────────────────────────────────────────────

  router.post('/add/preview', validateBody(bulkAddSchema), (req, res, next) => {
    try {
      const { metadataId, type, start, end, ignoredEpisodes } = req.body;
      const tagId = pipeline.markerTagId ?? getMarkerTagId(db);
      if (!tagId) {
        res.json({ success: true, data: { additions: 0, modifications: 0, deletions: 0, affected: [], hasConflicts: false } });
        return;
      }

      const item = db.get<{ library_section_id: number }>('SELECT library_section_id FROM metadata_items WHERE id = ?', metadataId);
      if (!item) { res.status(404).json({ success: false, error: 'Metadata item not found' }); return; }

      const episodeIds = getEpisodeIds(db, metadataId);
      const result = buildBulkAddStatements(db, tagId, item.library_section_id, episodeIds, type, start, end, new Set(ignoredEpisodes));

      res.json({
        success: true,
        data: {
          additions: result.added,
          modifications: 0,
          deletions: 0,
          affected: [],
          hasConflicts: false,
          skipped: result.skipped,
          totalEpisodes: episodeIds.length,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/add/commit', validateBody(bulkAddSchema), async (req, res, next) => {
    try {
      const { metadataId, type, start, end, ignoredEpisodes } = req.body;
      const tagId = pipeline.markerTagId ?? getMarkerTagId(db);
      if (!tagId) { res.status(500).json({ success: false, error: 'No marker tag found' }); return; }

      const item = db.get<{ library_section_id: number }>('SELECT library_section_id FROM metadata_items WHERE id = ?', metadataId);
      if (!item) { res.status(404).json({ success: false, error: 'Metadata item not found' }); return; }

      const episodeIds = getEpisodeIds(db, metadataId);
      const { statements, added, skipped } = buildBulkAddStatements(db, tagId, item.library_section_id, episodeIds, type, start, end, new Set(ignoredEpisodes));

      if (statements.length === 0) {
        res.json({ success: true, data: { markersAffected: 0 } });
        return;
      }

      const result = await pipeline.execute(db, statements, 'bulk-add', `Bulk add ${type} markers to ${added} episodes under item ${metadataId}`);

      if (!result.success) {
        res.status(result.statusCode ?? (result.conflict ? 409 : 500)).json({ success: false, error: result.error, conflict: result.conflict });
        return;
      }

      res.json({ success: true, data: { markersAffected: added, skipped } });
    } catch (err) {
      next(err);
    }
  });

  // ── Bulk Delete ──────────────────────────────────────────────

  router.post('/delete/preview', validateBody(bulkDeleteSchema), (req, res, next) => {
    try {
      const { metadataId, markerType, ignoredMarkerIds } = req.body;
      const tagId = pipeline.markerTagId ?? getMarkerTagId(db);
      if (!tagId) { res.json({ success: true, data: { additions: 0, modifications: 0, deletions: 0, affected: [], hasConflicts: false } }); return; }

      const item = db.get<{ library_section_id: number }>('SELECT library_section_id FROM metadata_items WHERE id = ?', metadataId);
      if (!item) { res.status(404).json({ success: false, error: 'Metadata item not found' }); return; }

      const episodeIds = getEpisodeIds(db, metadataId);
      const result = buildBulkDeleteStatements(db, tagId, item.library_section_id, episodeIds, markerType, new Set(ignoredMarkerIds));

      res.json({
        success: true,
        data: {
          additions: 0,
          modifications: 0,
          deletions: result.deleted,
          affected: [],
          hasConflicts: false,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/delete/commit', validateBody(bulkDeleteSchema), async (req, res, next) => {
    try {
      const { metadataId, markerType, ignoredMarkerIds } = req.body;
      const tagId = pipeline.markerTagId ?? getMarkerTagId(db);
      if (!tagId) { res.status(500).json({ success: false, error: 'No marker tag found' }); return; }

      const item = db.get<{ library_section_id: number }>('SELECT library_section_id FROM metadata_items WHERE id = ?', metadataId);
      if (!item) { res.status(404).json({ success: false, error: 'Metadata item not found' }); return; }

      const episodeIds = getEpisodeIds(db, metadataId);
      const { statements, deleted } = buildBulkDeleteStatements(db, tagId, item.library_section_id, episodeIds, markerType, new Set(ignoredMarkerIds));

      if (statements.length === 0) {
        res.json({ success: true, data: { markersAffected: 0 } });
        return;
      }

      const result = await pipeline.execute(db, statements, 'bulk-delete', `Bulk delete ${deleted} markers under item ${metadataId}`);

      if (!result.success) {
        res.status(result.statusCode ?? (result.conflict ? 409 : 500)).json({ success: false, error: result.error, conflict: result.conflict });
        return;
      }

      res.json({ success: true, data: { markersAffected: deleted } });
    } catch (err) {
      next(err);
    }
  });

  // ── Bulk Shift ───────────────────────────────────────────────

  router.post('/shift/preview', validateBody(bulkShiftSchema), (req, res, next) => {
    try {
      const { metadataId, startShift, endShift, markerType, ignoredMarkerIds } = req.body;
      const tagId = pipeline.markerTagId ?? getMarkerTagId(db);
      if (!tagId) { res.json({ success: true, data: { additions: 0, modifications: 0, deletions: 0, affected: [], hasConflicts: false } }); return; }

      const item = db.get<{ library_section_id: number }>('SELECT library_section_id FROM metadata_items WHERE id = ?', metadataId);
      if (!item) { res.status(404).json({ success: false, error: 'Metadata item not found' }); return; }

      const episodeIds = getEpisodeIds(db, metadataId);
      const result = buildBulkShiftStatements(db, tagId, item.library_section_id, episodeIds, startShift, endShift, markerType, new Set(ignoredMarkerIds));

      res.json({
        success: true,
        data: {
          additions: 0,
          modifications: result.shifted,
          deletions: 0,
          affected: [],
          hasConflicts: false,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/shift/commit', validateBody(bulkShiftSchema), async (req, res, next) => {
    try {
      const { metadataId, startShift, endShift, markerType, ignoredMarkerIds } = req.body;
      const tagId = pipeline.markerTagId ?? getMarkerTagId(db);
      if (!tagId) { res.status(500).json({ success: false, error: 'No marker tag found' }); return; }

      const item = db.get<{ library_section_id: number }>('SELECT library_section_id FROM metadata_items WHERE id = ?', metadataId);
      if (!item) { res.status(404).json({ success: false, error: 'Metadata item not found' }); return; }

      const episodeIds = getEpisodeIds(db, metadataId);
      const { statements, shifted } = buildBulkShiftStatements(db, tagId, item.library_section_id, episodeIds, startShift, endShift, markerType, new Set(ignoredMarkerIds));

      if (statements.length === 0) {
        res.json({ success: true, data: { markersAffected: 0 } });
        return;
      }

      const result = await pipeline.execute(db, statements, 'bulk-shift', `Bulk shift ${shifted} markers under item ${metadataId}`);

      if (!result.success) {
        res.status(result.statusCode ?? (result.conflict ? 409 : 500)).json({ success: false, error: result.error, conflict: result.conflict });
        return;
      }

      res.json({ success: true, data: { markersAffected: shifted } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
