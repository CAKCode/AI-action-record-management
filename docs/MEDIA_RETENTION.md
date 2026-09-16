# Generated media retention

The platform keeps one authoritative copy of a pytest HTML report and its
managed resources. A test project's generated `task/<run-id>/videos`
directory is a temporary local copy used by the report while the run is
active; after the report is archived and every regular file in that directory
has a matching managed resource, the platform removes this local copy. Files
that were not mounted into the HTML keep the whole directory in place and add
a visible worklog warning. The original media under the operator's
source root (for example `/data/jenkins/videos`) is not removed by the
platform. `standard_videos` is a separate fixture library and is never a
cleanup target.

The platform removes a completed Run's project `task/<run-id>/videos` copy
after successful artifact archival. Resource registrations from every report
in the same Step Run participate in the completeness check. The artifact job
performs cleanup before it is marked completed; inspection or removal failures
leave the job retryable. A later report revision reuses each prior artifact
whose declaration and source-file SHA-256 are unchanged, even when the revision
adds another artifact such as failure analysis Markdown.
Browser-compatible HLS playback may create one SHA-256-addressed MP4 stream-copy
cache under the owning Task's `skill-report-artifacts/.playback-cache` only when
no paired MP4 already exists. This is a derived cache rather than another
archived media object; it is excluded with the surrounding report artifact
tree from database/recovery packages and is removed by the same Task retention
lifecycle.
`bin/media-retention-cleanup.js` remains the supported fallback for legacy
generated-media layouts left behind by interrupted runs.
It requires explicit video roots through `CODEX_MEDIA_CLEANUP_ROOTS` (a
colon-separated list on Linux) and is dry-run by default. A production timer
must pass `--apply`. Each scheduled run performs the following checks:

1. It reads the platform SQLite database in read-only mode. Non-terminal Tasks,
   non-terminal or not-yet-verified External Attempts, and pending/failed
   report-artifact jobs contribute active paths. A run is protected when it
   contains one of those paths; a project-root working directory does not hide
   every unrelated historical run below it.
2. It scans only direct run directories below each configured `videos` root.
   Symlinks, special files, hidden entries, `standard_videos`, and entries
   whose directory or newest contained file is newer than 30 days are skipped.
3. Eligible directories are renamed into the root's
   `.retention-quarantine/` directory. They are permanently removed only after
   the quarantine period (default three days), giving operators a recovery
   window and avoiding a recursive delete of a live source directory.
4. A lock file and append-only audit log make concurrent runs and every move or
   deletion observable.

The command refuses roots overlapping `CODEX_DESK_DATA_DIR`,
`CODEX_DESK_BACKUP_DIR`, or `CODEX_DESK_RUNTIME_DIR`. A project directory is
allowed as a parent because the intended root is commonly its explicit
`videos` child. It also fails closed if the platform database cannot be
inspected.

## Configuration

Example for a host that still has a legacy direct-run media root:

```text
CODEX_MEDIA_CLEANUP_ROOTS=/home/jenkins/premium_robot/videos
CODEX_MEDIA_RETENTION_DAYS=30
CODEX_MEDIA_QUARANTINE_DAYS=3
```

The new `task/<run-id>/videos` layout is normally removed by its completed
artifact job and should not be replaced with a broad `task` cleanup root.

Do not configure `/data/jenkins/videos` or another operator-managed source
root for automatic cleanup. The source tree and standard fixtures may live
under that path and must not be treated as disposable output. Configure only
project-local generated-media roots for the fallback command.

## Long-term media backup

Media that must survive the 30-day source cleanup belongs in an external
content-addressed store. Before the source directory is eligible for cleanup,
the backup process should hash each regular media file with SHA-256, publish
one object per digest, and record a manifest mapping the run, relative path,
size, and digest to that object. Re-running the backup is incremental and
idempotent because the digest is the object key. This repository does not
implement that external object store; `media-retention-cleanup.js` only
enforces the temporary-source lifecycle. Keep `standard_videos` on its own
backup and retention policy.

## Dry run and timer

Preview without changing files:

```bash
CODEX_MEDIA_CLEANUP_ROOTS=/home/jenkins/premium_robot/videos \
  npm run media:retention -- --dry-run
```

The example systemd service and timer use `OnUnitActiveSec=30d`, which is a
rolling 30-day interval rather than a calendar-month approximation. Install
and enable them only after reviewing a dry-run and replacing the example
paths:

```bash
sudo install -m 0644 deploy/codex-media-retention.service.example /etc/systemd/system/codex-media-retention.service
sudo install -m 0644 deploy/codex-media-retention.timer.example /etc/systemd/system/codex-media-retention.timer
sudo systemctl daemon-reload
sudo systemctl enable --now codex-media-retention.timer
```

The existing platform Worker continues to enforce its own 30-day completed
Task/report retention. This job does not delete SQLite, WAL files, backups,
recovery checkpoints, or platform-managed report artifacts. New recovery
checkpoints also exclude `data/sessions/*/skill-report-artifacts`, so those
large managed copies are not multiplied by the checkpoint retention count.
