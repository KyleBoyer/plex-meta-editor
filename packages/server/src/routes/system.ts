import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { SafeDB } from '../db/connection.js';
import type { AppConfig } from '../config.js';
import { PlexSqliteUnavailableError } from '../db/plex-sqlite.js';
import type { SafetyPipelineState } from '../safety/pipeline.js';

export function createSystemRoutes(db: SafeDB, config: AppConfig, pipeline: SafetyPipelineState): Router {
  const router = Router();

  // GET /api/status — system status
  router.get('/status', (_req, res, next) => {
    try {
      const stat = fs.statSync(config.dbPath);
      const backupDir = config.backupDir;
      let backupCount = 0;

      if (fs.existsSync(backupDir)) {
        backupCount = fs.readdirSync(backupDir).filter(f => f.endsWith('.db')).length;
      }

      res.json({
        success: true,
        data: {
          connected: db.isOpen,
          dbPath: config.dbPath,
          uptime: process.uptime(),
          dbFileSize: stat.size,
          dbLastModified: stat.mtimeMs,
          backupCount,
          writeMode: config.writeMode,
          plexSqlitePath: config.plexSqlitePath,
          plexSqliteAvailable: config.plexSqliteAvailable,
          plexSqliteStartupError: config.plexSqliteStartupError,
          plexConfigured: config.plexConfigured,
          plexReachable: config.plexReachable,
          plexAuthSource: config.plexAuthSource,
          plexStartupError: config.plexStartupError,
          lastIntegrityCheck: pipeline.lastIntegrityCheck,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/backups — list backups
  router.get('/backups', (_req, res, next) => {
    try {
      const backupDir = config.backupDir;
      if (!fs.existsSync(backupDir)) {
        res.json({ success: true, data: [] });
        return;
      }

      const files = fs.readdirSync(backupDir)
        .filter(f => f.endsWith('.db'))
        .map(f => {
          const stat = fs.statSync(path.join(backupDir, f));
          return {
            id: f.replace('.db', ''),
            filename: f,
            createdAt: stat.mtimeMs,
            size: stat.size,
          };
        })
        .sort((a, b) => b.createdAt - a.createdAt);

      res.json({ success: true, data: files });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/backup — create manual backup
  router.post('/backup', (_req, res, next) => {
    try {
      if (!fs.existsSync(config.backupDir)) {
        fs.mkdirSync(config.backupDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFilename = `plex-db-backup-${timestamp}.db`;
      const backupPath = path.join(config.backupDir, backupFilename);

      fs.copyFileSync(config.dbPath, backupPath);

      const stat = fs.statSync(backupPath);
      res.json({
        success: true,
        data: {
          id: backupFilename.replace('.db', ''),
          filename: backupFilename,
          createdAt: stat.mtimeMs,
          size: stat.size,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/db-check — run a manual full database integrity check
  router.post('/db-check', async (_req, res, next) => {
    try {
      const result = await pipeline.runManualIntegrityCheck();
      res.json({ success: true, data: result });
    } catch (err) {
      if (err instanceof PlexSqliteUnavailableError) {
        res.status(503).json({ success: false, error: err.message });
        return;
      }
      next(err);
    }
  });

  return router;
}
