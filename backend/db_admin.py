from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from .storage import (
    CACHE_BODY_COMPRESSION_MAGIC,
    CACHE_BODY_COMPRESSION_MIN_BYTES,
    DB_PATH,
    RAW_DIR,
    SCHEMA_VERSION,
    database_status,
    encode_cache_body,
    migrate_database,
)


def positive_int_env(name: str, default: int) -> int:
    try:
        return max(int(os.environ.get(name, str(default))), 1)
    except ValueError:
        return default


def prune_raw_responses(
    raw_dir: Path = RAW_DIR,
    *,
    retention_days: int = 7,
    now: datetime | None = None,
) -> dict[str, int]:
    current = now or datetime.now(ZoneInfo("Asia/Shanghai"))
    cutoff = (current - timedelta(days=max(retention_days, 1))).date()
    removed_directories = 0
    removed_bytes = 0
    if not raw_dir.exists():
        return {"removedDirectories": 0, "removedBytes": 0}
    for path in raw_dir.iterdir():
        if not path.is_dir():
            continue
        try:
            day = datetime.strptime(path.name, "%Y%m%d").date()
        except ValueError:
            continue
        if day >= cutoff:
            continue
        removed_bytes += sum(item.stat().st_size for item in path.rglob("*") if item.is_file())
        shutil.rmtree(path)
        removed_directories += 1
    return {"removedDirectories": removed_directories, "removedBytes": removed_bytes}


def optimize_database(
    path: Path = DB_PATH,
    *,
    response_cache_retention_days: int = 14,
    snapshot_retention_days: int = 7,
    raw_retention_days: int = 7,
    raw_dir: Path = RAW_DIR,
    now: datetime | None = None,
    vacuum: bool = False,
    response_cache_max_bytes: int = 64 * 1024 * 1024,
) -> dict[str, object]:
    current = now or datetime.now(ZoneInfo("Asia/Shanghai"))
    response_cutoff_ms = int((current - timedelta(days=max(response_cache_retention_days, 1))).timestamp() * 1000)
    snapshot_cutoff_ms = int((current - timedelta(days=max(snapshot_retention_days, 1))).timestamp() * 1000)
    with sqlite3.connect(path, timeout=10.0) as conn:
        conn.execute("PRAGMA busy_timeout = 10000")
        # Commit each bounded write before scanning/compressing the next batch.
        # CPU work under a write transaction used to starve the worker's lease.
        def delete_batches(table: str, predicate: str, cutoff: int) -> int:
            total = 0
            while True:
                count = conn.execute(
                    f"DELETE FROM {table} WHERE rowid IN (SELECT rowid FROM {table} WHERE {predicate} LIMIT 500)",
                    (cutoff,),
                ).rowcount
                conn.commit()
                total += count
                if count < 500:
                    return total

        deleted_cache_rows = delete_batches('response_cache', 'fetched_at < ?', response_cutoff_ms)
        deleted_snapshot_rows = delete_batches('market_quote_snapshots', 'captured_at < ?', snapshot_cutoff_ms)
        delete_batches('dashboard_snapshots', "name LIKE 'fund-detail:%' AND generated_at < ?", snapshot_cutoff_ms)
        deduplicated_snapshot_rows = 0
        deduplicated_snapshot_bytes = 0
        cursor = 0
        while True:
            rows = conn.execute(
                "SELECT rowid,raw_line FROM market_quote_snapshots WHERE rowid>? "
                "AND raw_line<>'' AND raw_line=sanitized_line ORDER BY rowid LIMIT 500", (cursor,),
            ).fetchall()
            if not rows:
                break
            for row_id, line in rows:
                count = conn.execute(
                    "UPDATE market_quote_snapshots SET raw_line='' WHERE rowid=? AND raw_line=? AND raw_line=sanitized_line",
                    (row_id, line),
                ).rowcount
                deduplicated_snapshot_rows += count
                deduplicated_snapshot_bytes += count * len(line)
            conn.commit()
            cursor = rows[-1][0]

        compressed_cache_rows = 0
        compressed_cache_bytes_saved = 0
        cursor = 0
        while True:
            rows = conn.execute(
                "SELECT rowid,cache_key,body FROM response_cache WHERE rowid>? AND length(body)>=? "
                "AND substr(body,1,?)<>? ORDER BY rowid LIMIT 25",
                (cursor, CACHE_BODY_COMPRESSION_MIN_BYTES, len(CACHE_BODY_COMPRESSION_MAGIC), CACHE_BODY_COMPRESSION_MAGIC),
            ).fetchall()
            if not rows:
                break
            compressed = [(key, bytes(body), encode_cache_body(bytes(body))) for _, key, body in rows]
            for key, original, encoded in compressed:
                if encoded != original:
                    # A refresh may have replaced this cache entry while we compressed it.
                    count = conn.execute("UPDATE response_cache SET body=? WHERE cache_key=? AND body=?",
                                         (encoded, key, original)).rowcount
                    compressed_cache_rows += count
                    compressed_cache_bytes_saved += count * (len(original) - len(encoded))
            conn.commit()
            cursor = rows[-1][0]
        # Preserve daily forecast results for calibration; trim only reconciled
        # large breakdowns after 30 days, in bounded optimistic updates.
        trimmed_estimate_rows = 0
        estimate_cutoff = (current - timedelta(days=30)).date().isoformat()
        cursor = 0
        while True:
            rows = conn.execute('''SELECT rowid,details_json FROM fund_estimate_snapshots
                WHERE rowid>? AND target_date<? AND actual_nav IS NOT NULL
                  AND (details_json LIKE '%"holdingContributions"%' OR details_json LIKE '%"benchmarkComponents"%')
                ORDER BY rowid LIMIT 100''', (cursor, estimate_cutoff)).fetchall()
            if not rows:
                break
            for row_id, original in rows:
                details = json.loads(original)
                details.pop('holdingContributions', None)
                details.pop('benchmarkComponents', None)
                trimmed_estimate_rows += conn.execute('UPDATE fund_estimate_snapshots SET details_json=? WHERE rowid=? AND details_json=?',
                    (json.dumps(details, ensure_ascii=False, separators=(',', ':')), row_id, original)).rowcount
            conn.commit()
            cursor = rows[-1][0]

        evicted_cache_bytes = 0
        cache_bytes = int(conn.execute('SELECT COALESCE(SUM(length(body)),0) FROM response_cache').fetchone()[0])
        for key, size, fetched in conn.execute('SELECT cache_key,length(body),fetched_at FROM response_cache ORDER BY fetched_at,cache_key').fetchall():
            if cache_bytes <= max(response_cache_max_bytes, 0):
                break
            removed = conn.execute('DELETE FROM response_cache WHERE cache_key=? AND length(body)=? AND fetched_at=?', (key, size, fetched)).rowcount
            cache_bytes -= removed * size
            evicted_cache_bytes += removed * size
            conn.commit()
        conn.execute("PRAGMA optimize")
        checkpoint = tuple(int(value) for value in conn.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchone())
        if vacuum:
            conn.execute("VACUUM")
        page_count = int(conn.execute("PRAGMA page_count").fetchone()[0])
        free_pages = int(conn.execute("PRAGMA freelist_count").fetchone()[0])
        page_size = int(conn.execute("PRAGMA page_size").fetchone()[0])
    raw_result = prune_raw_responses(raw_dir, retention_days=raw_retention_days, now=current)
    return {
        "deletedResponseCacheRows": max(deleted_cache_rows, 0),
        "deletedQuoteSnapshotRows": max(deleted_snapshot_rows, 0),
        "deduplicatedQuoteSnapshotRows": deduplicated_snapshot_rows,
        "deduplicatedQuoteSnapshotBytes": deduplicated_snapshot_bytes,
        "compressedResponseCacheRows": compressed_cache_rows,
        "compressedResponseCacheBytesSaved": compressed_cache_bytes_saved,
        "trimmedEstimateRows": trimmed_estimate_rows,
        "evictedResponseCacheBytes": evicted_cache_bytes,
        "raw": raw_result,
        "checkpoint": checkpoint,
        "pageCount": page_count,
        "freePages": free_pages,
        "reclaimableBytes": free_pages * page_size,
        "vacuumed": vacuum,
    }


def verify_database(path: Path) -> dict[str, object]:
    status = database_status(path)
    if not status["exists"]:
        raise RuntimeError(f"Database does not exist: {path}")
    if status["integrity"] != "ok":
        raise RuntimeError(f"Database integrity check failed: {status['integrity']}")
    version = int(status["schemaVersion"])
    if version > SCHEMA_VERSION:
        raise RuntimeError(f"Database schema {version} is newer than supported version {SCHEMA_VERSION}")
    return status


def backup_database(source: Path, destination: Path) -> Path:
    if source.resolve() == destination.resolve():
        raise RuntimeError("Backup destination must differ from the source database")
    verify_database(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise RuntimeError(f"Backup already exists: {destination}")
    with sqlite3.connect(source) as source_conn, sqlite3.connect(destination) as destination_conn:
        source_conn.backup(destination_conn)
    verify_database(destination)
    return destination


def verify_backup_restore(source: Path) -> dict[str, object]:
    """Exercise restoration and migration in a disposable directory only."""
    verify_database(source)
    tables = ('fund_nav_history', 'market_history', 'fund_holdings', 'stock_daily_history', 'fx_daily_history',
              'long_market_history', 'long_history_sync')
    with tempfile.TemporaryDirectory(prefix='fund-restore-check-') as directory:
        restored = Path(directory) / 'restored.db'
        with sqlite3.connect(f'{source.resolve().as_uri()}?mode=ro', uri=True) as original, sqlite3.connect(restored) as target:
            counts = {table: original.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0]
                      for table in tables if original.execute('SELECT 1 FROM sqlite_master WHERE name=?', (table,)).fetchone()}
            original.backup(target)
        migrate_database(restored)
        status = verify_database(restored)
        with sqlite3.connect(restored) as conn:
            for table, count in counts.items():
                if conn.execute(f'SELECT COUNT(*) FROM {table}').fetchone()[0] != count:
                    raise RuntimeError(f'Restore verification lost rows: {table}')
        return {'integrity': status['integrity'], 'schemaVersion': status['schemaVersion'], 'preservedRows': counts}


def default_backup_path(source: Path) -> Path:
    stamp = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y%m%d-%H%M%S")
    configured = os.environ.get("FUND_VALUATION_BACKUP_DIR", "").strip()
    directory = Path(configured) if configured else source.parent / "backups"
    return directory / f"{source.stem}-{stamp}.db"


def scheduled_backup_files(directory: Path, prefix: str) -> list[Path]:
    pattern = re.compile(rf'{re.escape(prefix)}-\d{{8}}-\d{{6}}\.db')
    return sorted(
        (path for path in directory.iterdir()
         if pattern.fullmatch(path.name) and not path.is_symlink() and path.is_file()
         and path.stat().st_nlink == 1),
        key=lambda path: path.name, reverse=True,
    ) if directory.exists() else []


def prune_backups(
    directory: Path, *, prefix: str, max_files: int,
    retention_days: int | None = None, now: datetime | None = None,
) -> dict[str, object]:
    if max_files < 1:
        raise ValueError('At least one backup must be retained')
    files = scheduled_backup_files(directory, prefix)
    current = now or datetime.now(ZoneInfo('Asia/Shanghai'))
    cutoff = current - timedelta(days=max(retention_days, 1)) if retention_days is not None else None
    retained = [path for index, path in enumerate(files) if index == 0 or (
        index < max_files and (cutoff is None or path.stat().st_mtime >= cutoff.timestamp()))]
    removed = [path for path in files if path not in retained]
    if removed:
        # Never discard older recovery points when a retained backup is corrupt.
        for path in retained:
            verify_database(path)
    removed_bytes = 0
    for path in removed:
        for candidate in (path, Path(str(path) + '-wal'), Path(str(path) + '-shm')):
            if candidate.is_file() and not candidate.is_symlink():
                removed_bytes += candidate.stat().st_size
                candidate.unlink()
    return {'retained': [path.name for path in retained],
            'removed': [path.name for path in removed], 'removedBytes': removed_bytes}


def ensure_recent_backup(
    source: Path,
    *,
    backup_dir: Path | None = None,
    interval_hours: int = 24,
    retention_days: int = 7,
    max_files: int = 1,
    now: datetime | None = None,
) -> Path | None:
    current = now or datetime.now(ZoneInfo("Asia/Shanghai"))
    configured = os.environ.get("FUND_VALUATION_BACKUP_DIR", "").strip()
    directory = backup_dir or (Path(configured) if configured else source.parent / "backups")
    existing = scheduled_backup_files(directory, source.stem)
    if existing:
        latest_age = current.timestamp() - existing[0].stat().st_mtime
        if latest_age < max(interval_hours, 1) * 60 * 60:
            prune_backups(directory, prefix=source.stem, max_files=max_files,
                          retention_days=retention_days, now=current)
            return None
    destination = directory / f"{source.stem}-{current.strftime('%Y%m%d-%H%M%S')}.db"
    backup_database(source, destination)
    prune_backups(directory, prefix=source.stem, max_files=max_files,
                  retention_days=retention_days, now=current)
    return destination


def restore_database(source: Path, destination: Path, *, confirmed: bool) -> Path | None:
    if not confirmed:
        raise RuntimeError("Restore requires --confirm RESTORE")
    if source.resolve() == destination.resolve():
        raise RuntimeError("Restore source must differ from the destination database")
    verify_database(source)
    safety_backup: Path | None = None
    if destination.exists():
        safety_backup = backup_database(destination, default_backup_path(destination).with_name(
            f"{destination.stem}-before-restore-{datetime.now(ZoneInfo('Asia/Shanghai')).strftime('%Y%m%d-%H%M%S-%f')}.db"
        ))
    destination.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source) as source_conn, sqlite3.connect(destination) as destination_conn:
        source_conn.backup(destination_conn)
    migrate_database(destination)
    verify_database(destination)
    return safety_backup


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SQLite maintenance for the fund valuation backend")
    subparsers = parser.add_subparsers(dest="command", required=True)

    status_parser = subparsers.add_parser("status", help="Show schema and integrity status")
    status_parser.add_argument("--database", type=Path, default=DB_PATH)

    migrate_parser = subparsers.add_parser("migrate", help="Apply pending schema migrations")
    migrate_parser.add_argument("--database", type=Path, default=DB_PATH)

    backup_parser = subparsers.add_parser("backup", help="Create and verify an online SQLite backup")
    backup_parser.add_argument("--database", type=Path, default=DB_PATH)
    backup_parser.add_argument("--output", type=Path)

    restore_parser = subparsers.add_parser("restore", help="Restore a verified backup")
    restore_parser.add_argument("backup", type=Path)
    restore_parser.add_argument("--database", type=Path, default=DB_PATH)
    restore_parser.add_argument("--confirm", metavar="RESTORE")
    verify_parser = subparsers.add_parser('verify-backup', help='Restore and migrate a backup in an isolated temporary directory')
    verify_parser.add_argument('backup', type=Path)

    prune_parser = subparsers.add_parser('prune-backups', help='Verify retained backups and remove older scheduled copies')
    prune_parser.add_argument('--kind', choices=('daily', 'deployment'), required=True)
    prune_parser.add_argument('--max-files', type=int, required=True)
    prune_parser.add_argument('--database', type=Path, default=DB_PATH)

    optimize_parser = subparsers.add_parser("optimize", help="Prune regenerable caches and run safe SQLite maintenance")
    optimize_parser.add_argument("--database", type=Path, default=DB_PATH)
    optimize_parser.add_argument(
        "--response-cache-retention-days",
        type=int,
        default=positive_int_env("FUND_VALUATION_RESPONSE_CACHE_RETENTION_DAYS", 14),
    )
    optimize_parser.add_argument(
        "--snapshot-retention-days",
        type=int,
        default=positive_int_env("FUND_VALUATION_SNAPSHOT_RETENTION_DAYS", 7),
    )
    optimize_parser.add_argument(
        "--raw-retention-days",
        type=int,
        default=positive_int_env("FUND_VALUATION_RAW_RETENTION_DAYS", 7),
    )
    optimize_parser.add_argument(
        "--vacuum",
        action="store_true",
        help="Rebuild the database file to release free pages; stop backend and worker first",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.command == "status":
        print(json.dumps(database_status(args.database), ensure_ascii=False, indent=2))
        return
    if args.command == "migrate":
        version = migrate_database(args.database)
        print(f"Database migrated to schema version {version}: {args.database}")
        return
    if args.command == 'verify-backup':
        print(json.dumps(verify_backup_restore(args.backup), indent=2))
        return
    if args.command == 'prune-backups':
        directory = default_backup_path(args.database).parent
        prefix = 'pre-deploy' if args.kind == 'deployment' else args.database.stem
        print(json.dumps(prune_backups(directory, prefix=prefix, max_files=args.max_files), indent=2))
        return
    if args.command == "backup":
        destination = args.output or default_backup_path(args.database)
        backup_database(args.database, destination)
        print(f"Backup created: {destination}")
        return
    if args.command == "restore":
        safety_backup = restore_database(args.backup, args.database, confirmed=args.confirm == "RESTORE")
        print(f"Database restored from: {args.backup}")
        if safety_backup:
            print(f"Previous database backed up to: {safety_backup}")
        return
    if args.command == "optimize":
        result = optimize_database(
            args.database,
            response_cache_retention_days=args.response_cache_retention_days,
            snapshot_retention_days=args.snapshot_retention_days,
            raw_retention_days=args.raw_retention_days,
            raw_dir=args.database.parent / "raw",
            vacuum=args.vacuum,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
