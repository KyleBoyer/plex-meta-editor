import { Router } from 'express';
import { z } from 'zod';
import type { SafeDB } from '../db/connection.js';
import type { AppConfig } from '../config.js';
import { validateNewMarker, validateUpdateMarker } from '@plex-meta-editor/shared';
import { getMarkers, getMarkersRaw, getMarkerSummary, getEpisodeIds, getSiblingEpisodeIds, type MarkerSummaryEntry } from '../plex/queries.js';
import { getMarkerTagId, PlexMetadataType } from '../plex/schema.js';
import {
  buildAddMarkerStatements,
  buildEditMarkerStatements,
  buildDeleteMarkerStatements,
  OverlapError,
} from '../plex/mutations.js';
import type { SafetyPipelineState } from '../safety/pipeline.js';
import { validateBody } from '../middleware/validate.js';

const addMarkerSchema = z.object({
  parentId: z.number().int().positive(),
  type: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  isFinal: z.boolean().default(false),
});

const editMarkerSchema = z.object({
  type: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  isFinal: z.boolean().default(false),
});

export function createMarkerRoutes(db: SafeDB, config: AppConfig, pipeline: SafetyPipelineState): Router {
  const router = Router();

  // GET /api/markers/summary/season/:seasonId — marker summary for all episodes in a season
  router.get('/summary/season/:seasonId', (req, res, next) => {
    try {
      const seasonId = parseInt(req.params.seasonId as string, 10);
      const tagId = pipeline.markerTagId ?? getMarkerTagId(db);
      if (!tagId) {
        res.json({ success: true, data: {} });
        return;
      }
      const episodeIds = getEpisodeIds(db, seasonId);
      const summary = getMarkerSummary(db, tagId, episodeIds);
      const data: Record<string, MarkerSummaryEntry[]> = {};
      for (const [id, entries] of summary) {
        data[id] = entries;
      }
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/markers/summary/library/:libraryId — marker summary for all movies in a library
  router.get('/summary/library/:libraryId', (req, res, next) => {
    try {
      const libraryId = parseInt(req.params.libraryId as string, 10);
      const tagId = pipeline.markerTagId ?? getMarkerTagId(db);
      if (!tagId) {
        res.json({ success: true, data: {} });
        return;
      }
      const movieIds = db.all<{ id: number }>(
        'SELECT id FROM metadata_items WHERE library_section_id = ? AND metadata_type = ? ORDER BY title_sort',
        libraryId, PlexMetadataType.Movie,
      ).map(r => r.id);
      const summary = getMarkerSummary(db, tagId, movieIds);
      const data: Record<string, MarkerSummaryEntry[]> = {};
      for (const [id, entries] of summary) {
        data[id] = entries;
      }
      res.json({ success: true, data });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/markers/:metadataId — all markers for an episode or movie
  router.get('/:metadataId', (req, res, next) => {
    try {
      const metadataId = parseInt(req.params.metadataId as string, 10);
      const markers = getMarkers(db, metadataId);
      res.json({ success: true, data: markers });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/markers — add a new marker (immediate write via safety pipeline)
  router.post('/', validateBody(addMarkerSchema), async (req, res, next) => {
    try {
      const newMarker = req.body;

      // Validate
      const errors = validateNewMarker(newMarker);
      if (errors.length > 0) {
        res.status(400).json({ success: false, error: errors.map(e => e.message).join('; ') });
        return;
      }

      // Ensure marker tag exists
      const tagId = pipeline.markerTagId ?? getMarkerTagId(db);
      if (!tagId) {
        res.status(500).json({ success: false, error: 'No marker tag found in database. Cannot add markers.' });
        return;
      }

      // Get existing markers for this parent
      const item = db.get<{ library_section_id: number }>(
        'SELECT library_section_id FROM metadata_items WHERE id = ?',
        newMarker.parentId
      );
      if (!item) {
        res.status(404).json({ success: false, error: 'Parent metadata item not found' });
        return;
      }

      const existing = getMarkersRaw(db, tagId, newMarker.parentId, item.library_section_id);

      // Build statements — also add to sibling episodes sharing the same file
      const siblingIds = getSiblingEpisodeIds(db, newMarker.parentId);
      let statements: { sql: string; params: unknown[] }[] = [];
      try {
        for (const sibId of siblingIds) {
          const sibItem = db.get<{ library_section_id: number }>(
            'SELECT library_section_id FROM metadata_items WHERE id = ?', sibId
          );
          if (!sibItem) continue;
          const sibExisting = getMarkersRaw(db, tagId, sibId, sibItem.library_section_id);
          const sibMarker = { ...newMarker, parentId: sibId };
          try {
            statements.push(...buildAddMarkerStatements(sibMarker, sibExisting, tagId));
          } catch (err) {
            // Skip siblings that already have this marker or would overlap
            if (!(err instanceof OverlapError) && sibId === newMarker.parentId) throw err;
          }
        }
      } catch (err) {
        if (err instanceof OverlapError) {
          res.status(409).json({ success: false, error: err.message });
          return;
        }
        throw err;
      }

      if (statements.length === 0) {
        res.status(409).json({ success: false, error: 'Marker overlaps with an existing marker on all episodes' });
        return;
      }

      // Execute through safety pipeline
      const result = await pipeline.execute(db, statements, 'add', `Add ${newMarker.type} marker to item ${newMarker.parentId}`);

      if (!result.success) {
        res.status(result.statusCode ?? (result.conflict ? 409 : 500)).json({
          success: false,
          error: result.error,
          conflict: result.conflict,
        });
        return;
      }

      // Fetch the newly added marker to return it
      const updatedMarkers = getMarkersRaw(db, tagId, newMarker.parentId, item.library_section_id);
      const addedMarker = updatedMarkers.find(m => m.start === newMarker.start && m.end === newMarker.end);

      res.json({ success: true, data: addedMarker || updatedMarkers[updatedMarkers.length - 1] });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/markers/:id — edit a marker (immediate write via safety pipeline)
  router.put('/:id', validateBody(editMarkerSchema), async (req, res, next) => {
    try {
      const markerId = parseInt(req.params.id as string, 10);
      const update = { ...req.body, id: markerId };

      // Validate
      const errors = validateUpdateMarker(update);
      if (errors.length > 0) {
        res.status(400).json({ success: false, error: errors.map(e => e.message).join('; ') });
        return;
      }

      const tagId = pipeline.markerTagId ?? getMarkerTagId(db);
      if (!tagId) {
        res.status(500).json({ success: false, error: 'No marker tag found' });
        return;
      }

      // Find the existing marker to get its parentId
      const existingMarker = db.get<{ metadata_item_id: number }>(
        'SELECT metadata_item_id FROM taggings WHERE id = ? AND tag_id = ?',
        markerId, tagId
      );
      if (!existingMarker) {
        res.status(404).json({ success: false, error: 'Marker not found' });
        return;
      }

      const item = db.get<{ library_section_id: number }>(
        'SELECT library_section_id FROM metadata_items WHERE id = ?',
        existingMarker.metadata_item_id
      );
      if (!item) {
        res.status(404).json({ success: false, error: 'Parent metadata item not found' });
        return;
      }

      const existing = getMarkersRaw(db, tagId, existingMarker.metadata_item_id, item.library_section_id);

      // Find the original marker's current values so we can match siblings
      const originalMarker = existing.find(m => m.id === markerId);
      if (!originalMarker) {
        res.status(404).json({ success: false, error: 'Marker not found in episode markers' });
        return;
      }

      // Build edit statements for this marker and matching markers on sibling episodes
      const siblingIds = getSiblingEpisodeIds(db, existingMarker.metadata_item_id);
      let statements: { sql: string; params: unknown[] }[] = [];
      try {
        // Edit the primary marker
        statements.push(...buildEditMarkerStatements(update, existing));

        // Edit matching markers on sibling episodes
        for (const sibId of siblingIds) {
          if (sibId === existingMarker.metadata_item_id) continue;
          const sibItem = db.get<{ library_section_id: number }>(
            'SELECT library_section_id FROM metadata_items WHERE id = ?', sibId
          );
          if (!sibItem) continue;
          const sibMarkers = getMarkersRaw(db, tagId, sibId, sibItem.library_section_id);
          // Find the duplicate marker by matching type + position
          const sibMatch = sibMarkers.find(m =>
            m.type === originalMarker.type && m.start === originalMarker.start && m.end === originalMarker.end
          );
          if (sibMatch) {
            const sibUpdate = { ...update, id: sibMatch.id };
            try {
              statements.push(...buildEditMarkerStatements(sibUpdate, sibMarkers));
            } catch { /* skip if sibling edit would cause overlap */ }
          }
        }
      } catch (err) {
        if (err instanceof OverlapError) {
          res.status(409).json({ success: false, error: err.message });
          return;
        }
        throw err;
      }

      const result = await pipeline.execute(db, statements, 'edit', `Edit marker ${markerId}`);

      if (!result.success) {
        res.status(result.statusCode ?? (result.conflict ? 409 : 500)).json({
          success: false,
          error: result.error,
          conflict: result.conflict,
        });
        return;
      }

      // Return updated marker
      const updatedMarkers = getMarkersRaw(db, tagId, existingMarker.metadata_item_id, item.library_section_id);
      const updated = updatedMarkers.find(m => m.id === markerId);

      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/markers/:id — delete a marker (immediate write via safety pipeline)
  router.delete('/:id', async (req, res, next) => {
    try {
      const markerId = parseInt(req.params.id as string, 10);

      const tagId = pipeline.markerTagId ?? getMarkerTagId(db);
      if (!tagId) {
        res.status(500).json({ success: false, error: 'No marker tag found' });
        return;
      }

      // Find the marker
      const markerRow = db.get<{ metadata_item_id: number }>(
        'SELECT metadata_item_id FROM taggings WHERE id = ? AND tag_id = ?',
        markerId, tagId
      );
      if (!markerRow) {
        res.status(404).json({ success: false, error: 'Marker not found' });
        return;
      }

      const item = db.get<{ library_section_id: number }>(
        'SELECT library_section_id FROM metadata_items WHERE id = ?',
        markerRow.metadata_item_id
      );
      if (!item) {
        res.status(404).json({ success: false, error: 'Parent metadata item not found' });
        return;
      }

      const existing = getMarkersRaw(db, tagId, markerRow.metadata_item_id, item.library_section_id);
      const deletedMarker = existing.find(m => m.id === markerId);

      // Delete the marker and matching duplicates on sibling episodes
      let statements = buildDeleteMarkerStatements(markerId, existing);

      if (deletedMarker) {
        const siblingIds = getSiblingEpisodeIds(db, markerRow.metadata_item_id);
        for (const sibId of siblingIds) {
          if (sibId === markerRow.metadata_item_id) continue;
          const sibItem = db.get<{ library_section_id: number }>(
            'SELECT library_section_id FROM metadata_items WHERE id = ?', sibId
          );
          if (!sibItem) continue;
          const sibMarkers = getMarkersRaw(db, tagId, sibId, sibItem.library_section_id);
          const sibMatch = sibMarkers.find(m =>
            m.type === deletedMarker.type && m.start === deletedMarker.start && m.end === deletedMarker.end
          );
          if (sibMatch) {
            statements = statements.concat(buildDeleteMarkerStatements(sibMatch.id, sibMarkers));
          }
        }
      }

      const result = await pipeline.execute(db, statements, 'delete', `Delete marker ${markerId} and siblings`);

      if (!result.success) {
        res.status(result.statusCode ?? (result.conflict ? 409 : 500)).json({
          success: false,
          error: result.error,
          conflict: result.conflict,
        });
        return;
      }

      res.json({ success: true, data: deletedMarker });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
