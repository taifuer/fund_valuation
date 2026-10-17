"""Read-only worker probe, independent of Flask and upstream availability."""
import json
import sqlite3
import time
from pathlib import Path

from .storage import DB_PATH


def worker_health(path: Path = DB_PATH, *, current_ms: int | None = None) -> dict:
    current = int(time.time() * 1000) if current_ms is None else current_ms
    try:
        with sqlite3.connect(f'{path.resolve().as_uri()}?mode=ro', uri=True, timeout=3) as conn:
            row = conn.execute("SELECT lease_until,last_run_at,last_success_at FROM background_jobs WHERE name='data-refresh'").fetchone()
        alive = bool(row and row[0] > 0 and -300_000 <= current - row[0] <= 120_000)
        return {'healthy': alive, 'reason': '' if alive else 'worker-heartbeat-stale',
                'lastRunAt': row[1] if row else 0, 'lastSuccessAt': row[2] if row else 0}
    except sqlite3.Error:
        return {'healthy': False, 'reason': 'database-unavailable'}


if __name__ == '__main__':
    result = worker_health()
    print(json.dumps(result))
    raise SystemExit(0 if result['healthy'] else 1)
