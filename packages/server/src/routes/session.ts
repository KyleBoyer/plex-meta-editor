import { Router } from 'express';
import fs from 'node:fs';
import type { SafeDB } from '../db/connection.js';
import type { AppConfig } from '../config.js';
import type { SafetyPipelineState } from '../safety/pipeline.js';

export function createSessionRoutes(db: SafeDB, config: AppConfig, pipeline: SafetyPipelineState): Router {
  const router = Router();

  // GET /api/session — current session state
  router.get('/', (_req, res, next) => {
    try {
      const stat = fs.statSync(config.dbPath);
      res.json({
        success: true,
        data: {
          connected: db.isOpen,
          dbPath: config.dbPath,
          dbFileSize: stat.size,
          dbLastModified: stat.mtimeMs,
          snapshotTakenAt: pipeline.lastSnapshot?.takenAt || 0,
          markerCount: pipeline.lastSnapshot?.markerCount || 0,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/session/history — write history
  router.get('/history', (_req, res) => {
    res.json({ success: true, data: pipeline.writeHistory });
  });

  // POST /api/session/check-conflicts — check for Plex changes since last snapshot
  router.post('/check-conflicts', (_req, res, next) => {
    try {
      if (!pipeline.lastSnapshot || !pipeline.markerTagId) {
        res.json({ success: true, data: null });
        return;
      }

      // Import dynamically to avoid circular deps
      const { detectConflicts } = require('../safety/conflict.js');
      const conflict = detectConflicts(db, pipeline.lastSnapshot, pipeline.markerTagId);
      res.json({ success: true, data: conflict });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
