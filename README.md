# Plex Meta Editor

Safety-first editing for Plex markers, chapters, and related media metadata.

> [!WARNING]
> This project writes directly to your Plex database.
>
> Any tool that edits `com.plexapp.plugins.library.db` has the potential to corrupt data, break markers or chapters, confuse Plex, or create damage you do not notice until later.
>
> Before using this project, make your own manual backup of the Plex database and store it somewhere outside the live Plex data directory.
>
> Plex Meta Editor is designed to be safer than many older Plex DB tools because it has automatic backups, conflict detection, transactional writes, integrity checks, and restore-on-failure behavior built in. That meaningfully reduces risk. It does not eliminate risk. Manual backups are still mandatory.

Plex Meta Editor is a local web app for browsing your Plex libraries and editing metadata with frame-level feedback from the actual media file. It focuses on the parts of Plex people often want to fix by hand: intro markers, credits markers, commercials, chapters, and multi-episode-file edge cases.

The big difference is the safety model. This project is intentionally built to behave more cautiously than tools that open the DB for direct mutation and hope for the best. Reads happen against a read-only connection. Writes are gated through Plex's official `Plex SQLite` binary, wrapped in a safety pipeline, and checked after every mutation.

## What It Can Do

- Browse Plex TV and movie libraries from the local database
- View and edit intro, credits, and commercial markers
- Add, edit, and delete markers with precise timestamps from a video player
- Bulk add, bulk delete, and bulk shift markers across a season or show
- Edit chapter data stored in `media_parts.extra_data`
- Work with multi-episode files and adjust episode boundary durations
- Mirror marker edits across sibling episodes that share the same file
- Stream media either directly from disk or through a fully proxied Plex playback path
- Auto-discover a local Plex token on server startup when the editor runs beside Plex
- Show backup and database-check diagnostics in the app

## Why This Is Safer

Compared to tools that write straight into the Plex DB with minimal safeguards, this project adds several layers of protection:

- Automatic backup before every write
- Conflict detection using DB snapshots and marker hashes
- All write statements executed inside a single transaction
- Writes performed through Plex's official `Plex SQLite` binary
- Full post-write integrity check using the official Plex SQLite binary
- Automatic restore from backup if the integrity check fails
- Marker index contiguity checks to catch a known corruption pattern
- Backup pruning and write history tracking
- Read-only browsing path when write prerequisites are not available

That is the core pitch: this tool is still risky because direct Plex DB mutation is risky, but it is engineered to be safer than many alternatives.

## How The Safety Pipeline Works

Every write goes through the same pipeline:

1. Take a fresh snapshot of the current marker state.
2. Detect whether Plex changed the DB since the last snapshot.
3. Refuse the write if a real conflict is found.
4. Create a timestamped backup of the DB.
5. Execute every SQL statement in one transaction.
6. Run an integrity check after the write.
7. Restore the backup automatically if the integrity check fails.
8. Refresh the read snapshot and prune old backups.

If Plex's official `Plex SQLite` binary is not available, mutating routes are disabled instead of silently falling back to a less safe write path.

## Requirements

- Node.js 20+ recommended
- A local Plex database file you can read
- Plex Media Server's official `Plex SQLite` binary for write operations
- Local access to media files if you want direct-file playback
- A reachable Plex server for proxied Plex playback

## Quick Start

Install dependencies:

```bash
npm install
```

If auto-discovery does not find your Plex install, set the paths explicitly:

```bash
export PLEX_DB_PATH="/path/to/Plex Media Server"
export PLEX_SQLITE_PATH="/path/to/Plex SQLite"
export PLEX_SERVER_URL="http://127.0.0.1:32400"
export PLEX_TOKEN="your-server-side-plex-token"
export BACKUP_DIR="/path/to/plex-meta-editor-backups"
```

`PLEX_DB_PATH` can point to either:

- the full `com.plexapp.plugins.library.db` file
- the Plex data directory that contains `Plug-in Support/Databases`

Start the app in development:

```bash
npm run dev
```

Then open:

- UI: [http://localhost:5173](http://localhost:5173)
- API: [http://localhost:3232](http://localhost:3232)

Before making any edits, open Settings in the app and confirm that `Plex SQLite` shows as available. If Plex playback is enabled, Settings will also show whether the server-side Plex startup check succeeded. If `Plex SQLite` is unavailable, browsing still works, but writes are intentionally blocked.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `PLEX_DB_PATH` | Plex DB file path or Plex data directory | Auto-discovered when possible |
| `PLEX_SQLITE_PATH` | Path to Plex's official SQLite binary | Auto-discovered when possible |
| `PLEX_SERVER_URL` | Plex base URL used by the server-side playback proxy | `http://127.0.0.1:32400` |
| `PLEX_TOKEN` | Plex auth token for the server-side playback proxy | Auto-discovered locally when possible |
| `BACKUP_DIR` | Where automatic backups are stored | `plex-meta-editor-backups` next to the DB |
| `MAX_BACKUPS` | Number of backups to retain | `50` |
| `BUSY_TIMEOUT` | SQLite busy timeout in ms | `5000` |
| `HOST` | Server bind host | `localhost` |
| `PORT` | Server port | `3232` |

## Playback Modes

### Direct File Mode

The app streams the media file directly from local disk through the editor server. This is the simplest option when the editor runs on the same machine that stores the media.

### Plex API Mode

The app proxies playback through your Plex server. The browser only talks to the editor app, so the Plex URL and token stay server-side. This is useful when direct file access is not available, when browser codec support is a problem, or when the editor is public but Plex stays private.

## Development

Run the full app:

```bash
npm run dev
```

Build everything:

```bash
npm run build
```

Typecheck packages:

```bash
npm run typecheck -w packages/server
npm run typecheck -w packages/client
```

## Project Structure

```text
packages/
  client/   React + Vite UI
  server/   Express API, Plex DB access, safety pipeline
  shared/   shared types, constants, validation
```

## Strong Recommendation

If you only remember one thing from this README, let it be this:

1. Make a manual backup first.
2. Let the app create its automatic backups too.
3. Treat the built-in safety features as an extra net, not a replacement for your own recovery plan.

That combination is what makes this tool safer than many other Plex DB editors, while still being honest about the fact that direct database editing always carries real risk.
