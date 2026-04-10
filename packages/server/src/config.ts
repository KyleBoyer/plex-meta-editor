import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_CONFIG, type PlexAuthSource } from '@plex-meta-editor/shared';
import { discoverLocalPlexToken } from './plex/token.js';

export interface AppConfig {
  /** Path to the Plex database file */
  dbPath: string;
  /** Server host */
  host: string;
  /** Server port */
  port: number;
  /** Directory for backups (absolute or relative to project root) */
  backupDir: string;
  /** Maximum number of backups to retain */
  maxBackups: number;
  /** SQLite busy timeout in ms */
  busyTimeout: number;
  /** Active write mode for the server */
  writeMode: 'hybrid-writes';
  /** Path to the official Plex SQLite binary, if found */
  plexSqlitePath: string | null;
  /** Whether the official Plex SQLite binary passed startup validation */
  plexSqliteAvailable: boolean;
  /** Startup error when Plex SQLite is unavailable */
  plexSqliteStartupError: string | null;
  /** Plex base URL used by server-side playback proxy */
  plexUrl: string | null;
  /** Plex auth token used by server-side playback proxy */
  plexToken: string | null;
  /** Whether Plex playback is configured server-side */
  plexConfigured: boolean;
  /** Whether startup verification reached Plex successfully */
  plexReachable: boolean;
  /** Where the active Plex token came from */
  plexAuthSource: PlexAuthSource | null;
  /** Startup error when Plex playback is unavailable */
  plexStartupError: string | null;
}

/** The Plex DB filename */
const PLEX_DB_FILENAME = 'com.plexapp.plugins.library.db';
const PLEX_SQLITE_ENV_VAR = 'PLEX_SQLITE_PATH';
const PLEX_URL_ENV_VAR = 'PLEX_SERVER_URL';
const PLEX_TOKEN_ENV_VAR = 'PLEX_TOKEN';
const DEFAULT_PLEX_URL = 'http://127.0.0.1:32400';

/** Relative path from the Plex data directory to the DB file */
const DB_RELATIVE_PATH = path.join('Plug-in Support', 'Databases', PLEX_DB_FILENAME);

/**
 * Load configuration from environment variables, with auto-discovery fallback.
 *
 * Priority:
 *   1. PLEX_DB_PATH env var (explicit path to .db file)
 *   2. Auto-discover from OS-specific default Plex data directories
 */
export async function loadConfig(): Promise<AppConfig> {
  // 1. Check explicit env var first
  let dbPath = process.env.PLEX_DB_PATH || '';

  if (dbPath) {
    // If they pointed at a directory, look for the DB file inside it
    dbPath = resolveDbPath(dbPath);
  } else {
    // 2. Auto-discover
    console.log('  PLEX_DB_PATH not set, attempting auto-discovery...');
    dbPath = discoverPlexDbPath();
  }

  if (!dbPath) {
    console.error('');
    console.error('Error: Could not find the Plex database.');
    console.error('');
    console.error('Set the PLEX_DB_PATH environment variable to the path of your Plex database:');
    console.error(`  export PLEX_DB_PATH="/path/to/${PLEX_DB_FILENAME}"`);
    console.error('');
    console.error('Common locations:');
    for (const hint of getLocationHints()) {
      console.error(`  ${hint}`);
    }
    process.exit(1);
  }

  if (!fs.existsSync(dbPath)) {
    console.error(`Error: Database file not found at: ${dbPath}`);
    process.exit(1);
  }

  const backupDir = process.env.BACKUP_DIR || path.join(path.dirname(dbPath), 'plex-meta-editor-backups');
  const plexSqlite = discoverPlexSqlite(dbPath);
  const plexConnection = await discoverPlexConnection(dbPath);

  return {
    dbPath,
    host: process.env.HOST || DEFAULT_CONFIG.host,
    port: parseInt(process.env.PORT || String(DEFAULT_CONFIG.port), 10),
    backupDir,
    maxBackups: parseInt(process.env.MAX_BACKUPS || String(DEFAULT_CONFIG.maxBackups), 10),
    busyTimeout: parseInt(process.env.BUSY_TIMEOUT || String(DEFAULT_CONFIG.busyTimeout), 10),
    writeMode: 'hybrid-writes',
    plexSqlitePath: plexSqlite.path,
    plexSqliteAvailable: plexSqlite.available,
    plexSqliteStartupError: plexSqlite.startupError,
    plexUrl: plexConnection.url,
    plexToken: plexConnection.token,
    plexConfigured: plexConnection.configured,
    plexReachable: plexConnection.reachable,
    plexAuthSource: plexConnection.authSource,
    plexStartupError: plexConnection.startupError,
  };
}

// ── Auto-Discovery ──────────────────────────────────────────────────

/**
 * Attempt to automatically find the Plex database by checking
 * OS-specific default locations.
 */
function discoverPlexDbPath(): string {
  const dataDir = getDefaultPlexDataDir();
  if (!dataDir) {
    return '';
  }

  const dbPath = path.join(dataDir, DB_RELATIVE_PATH);
  if (fs.existsSync(dbPath)) {
    console.log(`  Auto-discovered Plex database at: ${dbPath}`);
    return dbPath;
  }

  console.log(`  Found Plex data dir at ${dataDir} but database file not found within it.`);
  return '';
}

/**
 * If the user provided a directory path instead of a file path,
 * try to find the DB file inside it.
 */
function resolveDbPath(inputPath: string): string {
  try {
    const stat = fs.statSync(inputPath);
    if (stat.isFile()) {
      return inputPath;
    }
    if (stat.isDirectory()) {
      // Check if this is the Plex data dir (has Plug-in Support/Databases/ inside)
      const dbInside = path.join(inputPath, DB_RELATIVE_PATH);
      if (fs.existsSync(dbInside)) {
        console.log(`  PLEX_DB_PATH pointed to a directory; found database at: ${dbInside}`);
        return dbInside;
      }
      // Maybe they pointed at the Databases directory directly
      const dbDirect = path.join(inputPath, PLEX_DB_FILENAME);
      if (fs.existsSync(dbDirect)) {
        console.log(`  PLEX_DB_PATH pointed to a directory; found database at: ${dbDirect}`);
        return dbDirect;
      }
      console.error(`  PLEX_DB_PATH is a directory but "${PLEX_DB_FILENAME}" was not found inside it.`);
      return '';
    }
  } catch {
    // Path doesn't exist, return as-is and let the caller handle validation
  }
  return inputPath;
}

/**
 * Find the default Plex Media Server data directory for the current OS.
 * Returns the path to the "Plex Media Server" folder, or '' if not found.
 */
function getDefaultPlexDataDir(): string {
  const platform = process.platform;

  switch (platform) {
    // ── Windows ──────────────────────────────────────────────
    case 'win32': {
      // Check Windows registry first (handles custom install locations)
      const registryPath = getWin32DataPathFromRegistry();
      if (registryPath) {
        const pmsDir = path.join(registryPath, 'Plex Media Server');
        if (fs.existsSync(pmsDir)) {
          return pmsDir;
        }
      }

      // Default: %LOCALAPPDATA%\Plex Media Server
      if (process.env.LOCALAPPDATA) {
        const defaultDir = path.join(process.env.LOCALAPPDATA, 'Plex Media Server');
        if (fs.existsSync(defaultDir)) {
          return defaultDir;
        }
      }

      return '';
    }

    // ── macOS ────────────────────────────────────────────────
    case 'darwin': {
      const home = process.env.HOME || os.homedir();
      if (home) {
        const defaultDir = path.join(home, 'Library', 'Application Support', 'Plex Media Server');
        if (fs.existsSync(defaultDir)) {
          return defaultDir;
        }
      }
      return '';
    }

    // ── Linux ────────────────────────────────────────────────
    case 'linux':
    case 'aix':
    case 'openbsd':
    case 'sunos': {
      // Check PLEX_HOME env var (set by some Plex installers)
      if (process.env.PLEX_HOME) {
        const envDir = path.join(process.env.PLEX_HOME, 'Library', 'Application Support', 'Plex Media Server');
        if (fs.existsSync(envDir)) {
          return envDir;
        }
      }

      // Check PLEX_MEDIA_SERVER_APPLICATION_SUPPORT_DIR (official env var)
      if (process.env.PLEX_MEDIA_SERVER_APPLICATION_SUPPORT_DIR) {
        const envDir = path.join(process.env.PLEX_MEDIA_SERVER_APPLICATION_SUPPORT_DIR, 'Plex Media Server');
        if (fs.existsSync(envDir)) {
          return envDir;
        }
      }

      // Probe well-known locations
      const linuxPaths = [
        // Debian/Ubuntu package install
        '/var/lib/plexmediaserver/Library/Application Support/Plex Media Server',
        // Snap install
        '/var/snap/plexmediaserver/common/Library/Application Support/Plex Media Server',
        // Flatpak or manual
        '/var/lib/plex/Plex Media Server',
        // Docker (standard /config mount)
        '/config/Library/Application Support/Plex Media Server',
        // Synology DSM 7
        '/var/packages/PlexMediaServer/shares/PlexMediaServer/AppData/Plex Media Server',
        // Synology DSM 6
        '/var/packages/PlexMediaServer/home/Library/Application Support/Plex Media Server',
        // Synology alternate
        '/volume1/Plex/Library/Application Support/Plex Media Server',
        // QNAP
        '/share/EC-docker/plex/Library/Application Support/Plex Media Server',
        // Unraid
        '/mnt/user/appdata/plex/Library/Application Support/Plex Media Server',
        // TrueNAS SCALE (app)
        '/mnt/pool/ix-applications/releases/plex/volumes/data/Library/Application Support/Plex Media Server',
      ];

      for (const testPath of linuxPaths) {
        if (fs.existsSync(testPath)) {
          return testPath;
        }
      }

      // Also check if the plex user's home directory has it
      try {
        const plexHome = execSync('getent passwd plex 2>/dev/null || getent passwd plexmediaserver 2>/dev/null', { timeout: 5000 })
          .toString().trim();
        if (plexHome) {
          const homeDir = plexHome.split(':')[5]; // 6th field is home directory
          if (homeDir) {
            const plexDir = path.join(homeDir, 'Library', 'Application Support', 'Plex Media Server');
            if (fs.existsSync(plexDir)) {
              return plexDir;
            }
          }
        }
      } catch {
        // getent not available or user doesn't exist — that's fine
      }

      return '';
    }

    // ── FreeBSD / FreeNAS / TrueNAS Core ─────────────────────
    case 'freebsd': {
      const bsdPaths = [
        '/usr/local/plexdata/Plex Media Server',
        '/var/db/plexdata/Plex Media Server',
        '/mnt/data/plexmediaserver/Plex Media Server',
      ];
      for (const testPath of bsdPaths) {
        if (fs.existsSync(testPath)) {
          return testPath;
        }
      }
      return '';
    }

    default:
      return '';
  }
}

/**
 * Windows-specific: check the registry for a custom Plex data path.
 * Plex stores this at HKCU\SOFTWARE\Plex, Inc.\Plex Media Server\LocalAppDataPath
 */
function getWin32DataPathFromRegistry(): string {
  if (process.platform !== 'win32') return '';

  try {
    const output = execSync(
      'REG QUERY "HKCU\\SOFTWARE\\Plex, Inc.\\Plex Media Server" /v LocalAppDataPath',
      { timeout: 10000 }
    ).toString();

    const match = /REG_SZ\s+(?<dataPath>[^\r\n]+)/.exec(output);
    if (match?.groups?.dataPath) {
      const regPath = match.groups.dataPath.trim();
      if (fs.existsSync(regPath)) {
        return regPath;
      }
    }
  } catch {
    // Registry key doesn't exist or query failed — that's fine
  }

  return '';
}

/**
 * Get OS-appropriate hints for where the DB might be located.
 * Used in the error message when auto-discovery fails.
 */
function getLocationHints(): string[] {
  const platform = process.platform;
  const home = process.env.HOME || os.homedir();

  switch (platform) {
    case 'darwin':
      return [
        `macOS: ${home}/Library/Application Support/Plex Media Server/Plug-in Support/Databases/${PLEX_DB_FILENAME}`,
      ];
    case 'win32':
      return [
        `Windows: %LOCALAPPDATA%\\Plex Media Server\\Plug-in Support\\Databases\\${PLEX_DB_FILENAME}`,
      ];
    case 'linux':
      return [
        `Linux (apt/deb): /var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Plug-in Support/Databases/${PLEX_DB_FILENAME}`,
        `Linux (snap):    /var/snap/plexmediaserver/common/Library/Application Support/Plex Media Server/Plug-in Support/Databases/${PLEX_DB_FILENAME}`,
        `Docker:          /config/Library/Application Support/Plex Media Server/Plug-in Support/Databases/${PLEX_DB_FILENAME}`,
        `Synology:        /var/packages/PlexMediaServer/shares/PlexMediaServer/AppData/Plex Media Server/Plug-in Support/Databases/${PLEX_DB_FILENAME}`,
      ];
    case 'freebsd':
      return [
        `FreeBSD: /usr/local/plexdata/Plex Media Server/Plug-in Support/Databases/${PLEX_DB_FILENAME}`,
      ];
    default:
      return [
        `Set PLEX_DB_PATH to the full path of ${PLEX_DB_FILENAME}`,
      ];
  }
}

interface PlexSqliteDiscoveryResult {
  path: string | null;
  available: boolean;
  startupError: string | null;
}

interface PlexConnectionDiscoveryResult {
  url: string | null;
  token: string | null;
  configured: boolean;
  reachable: boolean;
  authSource: PlexAuthSource | null;
  startupError: string | null;
}

async function discoverPlexConnection(dbPath: string): Promise<PlexConnectionDiscoveryResult> {
  const explicitUrl = normalizeConfiguredValue(process.env[PLEX_URL_ENV_VAR] || '');
  const plexUrl = resolvePlexUrl(explicitUrl);

  if (!plexUrl) {
    return {
      url: null,
      token: null,
      configured: false,
      reachable: false,
      authSource: null,
      startupError: `${PLEX_URL_ENV_VAR} must be a valid http:// or https:// URL when set.`,
    };
  }

  const explicitToken = normalizeConfiguredValue(process.env[PLEX_TOKEN_ENV_VAR] || '');
  let token = explicitToken;
  let authSource: PlexAuthSource | null = explicitToken ? 'env' : null;

  if (!token) {
    const localToken = discoverLocalPlexToken(dbPath);
    if (localToken) {
      token = localToken.token;
      authSource = localToken.source;
    }
  }

  if (!token) {
    return {
      url: plexUrl,
      token: null,
      configured: false,
      reachable: false,
      authSource: null,
      startupError: [
        `Could not find a Plex token.`,
        `Set ${PLEX_TOKEN_ENV_VAR} on the server, or run the editor on the same machine as Plex so the token can be auto-discovered.`,
      ].join(' '),
    };
  }

  try {
    await verifyPlexConnection(plexUrl, token);
    return {
      url: plexUrl,
      token,
      configured: true,
      reachable: true,
      authSource,
      startupError: null,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      url: plexUrl,
      token,
      configured: true,
      reachable: false,
      authSource,
      startupError: [
        `Plex startup check failed: ${detail}`,
        explicitUrl && !explicitToken ? `If ${PLEX_URL_ENV_VAR} points at a different Plex server, set ${PLEX_TOKEN_ENV_VAR} explicitly.` : '',
      ].filter(Boolean).join(' '),
    };
  }
}

function discoverPlexSqlite(dbPath: string): PlexSqliteDiscoveryResult {
  const explicitPath = normalizeConfiguredPath(process.env[PLEX_SQLITE_ENV_VAR] || '');
  if (explicitPath) {
    const result = inspectPlexSqliteCandidate(explicitPath, dbPath);
    if (result.available) {
      return result;
    }
    return {
      path: result.path ?? explicitPath,
      available: false,
      startupError: result.startupError || `${PLEX_SQLITE_ENV_VAR} points to a missing Plex SQLite binary: ${explicitPath}`,
    };
  }

  let lastError: PlexSqliteDiscoveryResult | null = null;
  for (const candidate of getPlexSqliteCandidates()) {
    const result = inspectPlexSqliteCandidate(candidate, dbPath);
    if (result.available) {
      return result;
    }
    if (result.path) {
      lastError = result;
    }
  }

  if (lastError) {
    return lastError;
  }

  return {
    path: null,
    available: false,
    startupError: [
      `Could not find Plex SQLite.`,
      `Set ${PLEX_SQLITE_ENV_VAR} to the full path of the Plex SQLite binary.`,
      ...getPlexSqliteHints(),
    ].join(' '),
  };
}

function inspectPlexSqliteCandidate(candidatePath: string, dbPath: string): PlexSqliteDiscoveryResult {
  const normalizedPath = normalizeConfiguredPath(candidatePath);
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    return { path: null, available: false, startupError: null };
  }

  try {
    const stat = fs.statSync(normalizedPath);
    if (!stat.isFile()) {
      return {
        path: normalizedPath,
        available: false,
        startupError: `Plex SQLite path is not a file: ${normalizedPath}`,
      };
    }
    ensureExecutable(normalizedPath);
    smokeTestPlexSqlite(normalizedPath, dbPath);

    return {
      path: normalizedPath,
      available: true,
      startupError: null,
    };
  } catch (err) {
    return {
      path: normalizedPath,
      available: false,
      startupError: `Plex SQLite startup check failed at ${normalizedPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function normalizeConfiguredValue(input: string): string {
  return input.trim().replace(/^['"]|['"]$/g, '');
}

function normalizeConfiguredPath(inputPath: string): string {
  return normalizeConfiguredValue(inputPath);
}

function resolvePlexUrl(explicitUrl: string): string | null {
  const candidate = explicitUrl || DEFAULT_PLEX_URL;

  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

async function verifyPlexConnection(plexUrl: string, plexToken: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const url = new URL('/identity', `${plexUrl}/`);
    url.searchParams.set('X-Plex-Token', plexToken);

    const res = await fetch(url, {
      headers: { Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8' },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Plex returned ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Timed out connecting to Plex');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function ensureExecutable(filePath: string): void {
  if (process.platform === 'win32') {
    return;
  }
  fs.accessSync(filePath, fs.constants.X_OK);
}

function smokeTestPlexSqlite(binaryPath: string, dbPath: string): void {
  execFileSync(
    binaryPath,
    ['-readonly', dbPath],
    {
      input: 'PRAGMA schema_version;\n',
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    },
  );
}

function getPlexSqliteCandidates(): string[] {
  switch (process.platform) {
    case 'darwin':
      return [
        '/Applications/Plex Media Server.app/Contents/MacOS/Plex SQLite',
      ];
    case 'win32':
      return [
        'C:\\Program Files\\Plex\\Plex Media Server\\Plex SQLite.exe',
        'C:\\Program Files (x86)\\Plex\\Plex Media Server\\Plex SQLite.exe',
      ];
    case 'linux':
    case 'aix':
    case 'openbsd':
    case 'sunos':
      return [
        '/usr/lib/plexmediaserver/Plex SQLite',
        '/share/CACHEDEV1_DATA/.qpkg/PlexMediaServer/Plex SQLite',
        '/var/packages/Plex Media Server/target/Plex SQLite',
        '/var/packages/PlexMediaServer/target/Plex SQLite',
      ];
    default:
      return [];
  }
}

function getPlexSqliteHints(): string[] {
  switch (process.platform) {
    case 'darwin':
      return [
        'Default macOS location: /Applications/Plex Media Server.app/Contents/MacOS/Plex SQLite',
      ];
    case 'win32':
      return [
        'Default Windows locations: C:\\Program Files\\Plex\\Plex Media Server\\Plex SQLite.exe or C:\\Program Files (x86)\\Plex\\Plex Media Server\\Plex SQLite.exe',
      ];
    case 'linux':
      return [
        'Default Linux locations include /usr/lib/plexmediaserver/Plex SQLite, /share/CACHEDEV1_DATA/.qpkg/PlexMediaServer/Plex SQLite, /var/packages/Plex Media Server/target/Plex SQLite, and /var/packages/PlexMediaServer/target/Plex SQLite',
      ];
    default:
      return [];
  }
}
