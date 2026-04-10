import fs from 'node:fs';
import path from 'node:path';

export interface BackupResult {
  backupPath: string;
  filename: string;
  size: number;
  createdAt: number;
}

/**
 * Create a timestamped backup of the Plex database file.
 * This is called before every write operation in the safety pipeline.
 */
export function createBackup(dbPath: string, backupDir: string): BackupResult {
  // Ensure backup directory exists
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `plex-db-backup-${timestamp}.db`;
  const backupPath = path.join(backupDir, filename);

  // Use fs.copyFileSync for atomic copy
  fs.copyFileSync(dbPath, backupPath);

  const stat = fs.statSync(backupPath);

  console.log(`  Backup created: ${filename} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);

  return {
    backupPath,
    filename,
    size: stat.size,
    createdAt: Date.now(),
  };
}

/**
 * Restore from a backup file by copying it back to the original location.
 */
export function restoreBackup(backupPath: string, dbPath: string): void {
  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup file not found: ${backupPath}`);
  }

  fs.copyFileSync(backupPath, dbPath);
  console.log(`  Database restored from backup: ${path.basename(backupPath)}`);
}

/**
 * Prune old backups, keeping only the most recent N.
 */
export function pruneBackups(backupDir: string, maxBackups: number): number {
  if (!fs.existsSync(backupDir)) return 0;

  const files = fs.readdirSync(backupDir)
    .filter(f => f.startsWith('plex-db-backup-') && f.endsWith('.db'))
    .map(f => ({
      name: f,
      path: path.join(backupDir, f),
      mtime: fs.statSync(path.join(backupDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime); // newest first

  let pruned = 0;
  for (let i = maxBackups; i < files.length; i++) {
    fs.unlinkSync(files[i].path);
    pruned++;
  }

  if (pruned > 0) {
    console.log(`  Pruned ${pruned} old backup(s), keeping ${maxBackups}`);
  }

  return pruned;
}

/**
 * List all available backups.
 */
export function listBackups(backupDir: string): BackupResult[] {
  if (!fs.existsSync(backupDir)) return [];

  return fs.readdirSync(backupDir)
    .filter(f => f.startsWith('plex-db-backup-') && f.endsWith('.db'))
    .map(f => {
      const fullPath = path.join(backupDir, f);
      const stat = fs.statSync(fullPath);
      return {
        backupPath: fullPath,
        filename: f,
        size: stat.size,
        createdAt: stat.mtimeMs,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}
