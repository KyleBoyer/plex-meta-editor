import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { loadConfig } from './config.js';
import { SafeDB } from './db/connection.js';
import { PlexSqliteService } from './db/plex-sqlite.js';
import { SafetyPipelineState } from './safety/pipeline.js';
import { errorHandler } from './middleware/error.js';
import { requireAuth } from './middleware/auth.js';
import { createAuthRoutes } from './routes/auth.js';
import { createLibraryRoutes } from './routes/libraries.js';
import { createShowRoutes } from './routes/shows.js';
import { createMovieRoutes } from './routes/movies.js';
import { createEpisodeRoutes } from './routes/episodes.js';
import { createMarkerRoutes } from './routes/markers.js';
import { createMediaRoutes } from './routes/media.js';
import { createBulkRoutes } from './routes/bulk.js';
import { createChapterRoutes } from './routes/chapters.js';
import { createSessionRoutes } from './routes/session.js';
import { createSystemRoutes } from './routes/system.js';
import { createAdminRoutes } from './routes/admin.js';
import { loadAllowedUsers } from './auth/allowed-users.js';

const config = await loadConfig();

// Load the file-based allowed users list
loadAllowedUsers();

console.log(`Plex Meta Editor starting...`);
console.log(`  Database: ${config.dbPath}`);
console.log(`  Backups:  ${config.backupDir}`);
console.log(`  Write mode: ${config.writeMode}`);
if (config.plexSqliteAvailable) {
  console.log(`  Plex SQLite: ${config.plexSqlitePath}`);
} else {
  console.warn(`  Plex SQLite unavailable: ${config.plexSqliteStartupError}`);
}
if (config.plexConfigured) {
  if (config.plexReachable) {
    console.log(`  Plex proxy: available (${config.plexAuthSource ?? 'unknown'} token)`);
  } else {
    console.warn(`  Plex proxy startup check failed: ${config.plexStartupError}`);
  }
} else {
  console.warn(`  Plex proxy unavailable: ${config.plexStartupError}`);
}

// Open database in read-only mode for browsing
const db = SafeDB.openReadOnly(config.dbPath, config.busyTimeout);
console.log(`  Connected to Plex database (read-only)`);

// Initialize safety pipeline (takes initial snapshot)
const plexSqlite = new PlexSqliteService(config);
const pipeline = new SafetyPipelineState(config, plexSqlite);
pipeline.initialize(db);

const app = express();
app.use(cors({
  origin: true,
  credentials: true,
  exposedHeaders: ['Content-Range', 'Content-Length', 'Accept-Ranges'],
}));
app.use(express.json());

// Auth routes (unauthenticated — must be before requireAuth)
app.use('/api/auth', createAuthRoutes(config));

// Protect all other API routes
app.use('/api', requireAuth);

// API routes
app.use('/api/libraries', createLibraryRoutes(db));
app.use('/api/shows', createShowRoutes(db));
app.use('/api/movies', createMovieRoutes(db));
app.use('/api/episodes', createEpisodeRoutes(db, config, pipeline));
app.use('/api/markers', createMarkerRoutes(db, config, pipeline));
app.use('/api/media', createMediaRoutes(db, config));
app.use('/api/bulk', createBulkRoutes(db, config, pipeline));
app.use('/api/chapters', createChapterRoutes(db, config, pipeline));
app.use('/api/session', createSessionRoutes(db, config, pipeline));
app.use('/api/admin', createAdminRoutes(config));
app.use('/api', createSystemRoutes(db, config, pipeline));

// Serve client in production
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.resolve(import.meta.dirname, '../../client/dist');
  app.use(express.static(clientDist));
  app.get('{*path}', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Error handler (must be last)
app.use(errorHandler);

const server = app.listen(config.port, config.host, () => {
  console.log(`  Server running at http://${config.host}:${config.port}`);
  console.log('');
});

// Graceful shutdown
const shutdown = () => {
  console.log('\nShutting down...');
  server.close(() => {
    db.close();
    console.log('Database closed. Goodbye.');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
