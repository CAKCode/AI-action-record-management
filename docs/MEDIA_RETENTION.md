# Generated media retention

The platform keeps one authoritative copy of a pytest HTML report and its
managed resources. A test project's generated `videos/<run-id>` directories
are temporary source material; they are not included in the platform's SQLite
backup or recovery-checkpoint policy. `standard_videos` is a separate fixture
library and is never a cleanup target.

`bin/media-retention-cleanup.js` is the only supported cleanup command. It
requires explicit video roots through `CODEX_MEDIA_CLEANUP_ROOTS` (a
colon-separated list on Linux) and is dry-run by default. A production timer
must pass `--apply`.

Each run performs the following checks:

1. It reads the platform SQLite database in read-only mode. Non-terminal Tasks,
   non-terminal or not-yet-verified External Attempts, and pending/failed
   report-artifact jobs protect their working directories.
2. It scans only direct run directories below each configured `videos` root.
   Symlinks, special files, hidden entries, `standard_videos`, and entries
   newer than 30 days are skipped.
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

Example for a host that has two generated-media roots:

```text
CODEX_MEDIA_CLEANUP_ROOTS=/home/jenkins/premium_robot/videos:/home/jenkins/premium_robot/task/videos
CODEX_MEDIA_RETENTION_DAYS=30
CODEX_MEDIA_QUARANTINE_DAYS=3
```

Do not set `/data/jenkins` as a root unless the exact generated `videos`
directory has been identified. The source tree and standard fixtures may live
under that path and must not be treated as disposable output.

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
