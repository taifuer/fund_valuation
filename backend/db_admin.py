from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from .storage import DB_PATH, SCHEMA_VERSION, database_status, migrate_database


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


def default_backup_path(source: Path) -> Path:
    stamp = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y%m%d-%H%M%S")
    return source.parent / "backups" / f"{source.stem}-{stamp}.db"


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


if __name__ == "__main__":
    main()
