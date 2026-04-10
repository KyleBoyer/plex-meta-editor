import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PlexAuthSource } from '@plex-meta-editor/shared';

const PLEX_DB_FILENAME = 'com.plexapp.plugins.library.db';

interface LocalTokenResult {
  token: string;
  source: PlexAuthSource;
}

export function discoverLocalPlexToken(dbPath: string): LocalTokenResult | null {
  switch (process.platform) {
    case 'darwin':
      return discoverMacToken();
    case 'win32':
      return discoverWindowsToken();
    default:
      return discoverUnixToken(dbPath);
  }
}

function discoverMacToken(): LocalTokenResult | null {
  const plistPath = path.join(os.homedir(), 'Library', 'Preferences', 'com.plexapp.plexmediaserver.plist');
  if (!fs.existsSync(plistPath)) {
    return null;
  }

  const token = readMacTokenFromPlist(plistPath) || readMacTokenFromDefaults();
  return token ? { token, source: 'macos-plist' } : null;
}

function readMacTokenFromPlist(plistPath: string): string | null {
  try {
    const output = execFileSync(
      'plutil',
      ['-extract', 'PlexOnlineToken', 'raw', '-o', '-', plistPath],
      {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 64 * 1024,
      },
    ).trim();

    return output || null;
  } catch {
    return null;
  }
}

function readMacTokenFromDefaults(): string | null {
  try {
    const output = execFileSync(
      'defaults',
      ['read', 'com.plexapp.plexmediaserver', 'PlexOnlineToken'],
      {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 64 * 1024,
      },
    ).trim();

    return output || null;
  } catch {
    return null;
  }
}

function discoverWindowsToken(): LocalTokenResult | null {
  try {
    const output = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Plex, Inc.\\Plex Media Server', '/v', 'PlexOnlineToken'],
      {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 64 * 1024,
      },
    );

    const match = /\bPlexOnlineToken\s+REG_\w+\s+([^\r\n]+)/.exec(output);
    const token = match?.[1]?.trim();
    return token ? { token, source: 'windows-registry' } : null;
  } catch {
    return null;
  }
}

function discoverUnixToken(dbPath: string): LocalTokenResult | null {
  const prefsPath = getUnixPreferencesPath(dbPath);
  if (!prefsPath || !fs.existsSync(prefsPath)) {
    return null;
  }

  const xml = fs.readFileSync(prefsPath, 'utf8');
  const match = /\bPlexOnlineToken="([^"]+)"/.exec(xml);
  if (!match?.[1]) {
    return null;
  }

  return {
    token: decodeXmlAttribute(match[1]),
    source: 'preferences-xml',
  };
}

function getUnixPreferencesPath(dbPath: string): string | null {
  const normalized = path.normalize(dbPath);
  const suffix = path.join('Plug-in Support', 'Databases', PLEX_DB_FILENAME);

  if (normalized.endsWith(suffix)) {
    const plexDataDir = normalized.slice(0, normalized.length - suffix.length);
    return path.join(plexDataDir, 'Preferences.xml');
  }

  const candidate = path.resolve(path.dirname(normalized), '..', '..', 'Preferences.xml');
  return candidate;
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
