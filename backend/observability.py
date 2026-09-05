from __future__ import annotations

import json
import math
import threading
import time
from collections import Counter, deque
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any

from .storage import get_conn


class RequestMetrics:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._started_at = int(time.time() * 1000)
        self._request_count = 0
        self._total_duration_ms = 0.0
        self._max_duration_ms = 0.0
        self._status_counts: Counter[str] = Counter()
        self._cache_counts: Counter[str] = Counter()
        self._route_counts: Counter[str] = Counter()
        self._route_duration_ms: Counter[str] = Counter()
        self._route_samples: dict[str, deque[float]] = {}

    def record(self, route: str, status: int, duration_ms: float, cache_status: str) -> None:
        normalized_cache = cache_status.upper() if cache_status else "NONE"
        with self._lock:
            self._request_count += 1
            self._total_duration_ms += duration_ms
            self._max_duration_ms = max(self._max_duration_ms, duration_ms)
            self._status_counts[f"{status // 100}xx"] += 1
            self._cache_counts[normalized_cache] += 1
            self._route_counts[route] += 1
            self._route_duration_ms[route] += duration_ms
            self._route_samples.setdefault(route, deque(maxlen=256)).append(duration_ms)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            count = self._request_count
            routes = [
                {
                    "route": route,
                    "count": route_count,
                    "averageDurationMs": round(self._route_duration_ms[route] / route_count, 1),
                    "p95DurationMs": round(sorted(self._route_samples[route])[math.ceil(len(self._route_samples[route]) * 0.95) - 1], 1),
                    "sampleCount": len(self._route_samples[route]),
                }
                for route, route_count in self._route_counts.most_common(20)
            ]
            return {
                "processStartedAt": self._started_at,
                "scope": "process",
                "sampleWindow": "last 256 requests per route",
                "requestCount": count,
                "averageDurationMs": round(self._total_duration_ms / count, 1) if count else 0.0,
                "maxDurationMs": round(self._max_duration_ms, 1),
                "statusCounts": dict(self._status_counts),
                "cacheCounts": dict(self._cache_counts),
                "routes": routes,
            }


REQUEST_METRICS = RequestMetrics()


@contextmanager
def task_run(name: str):
    started = int(time.time() * 1000)
    clock = time.monotonic()
    result = {"error": ""}
    with get_conn() as conn:
        conn.execute("""INSERT INTO worker_task_status(name,started_at,run_count) VALUES (?,?,1)
            ON CONFLICT(name) DO UPDATE SET started_at=excluded.started_at,run_count=run_count+1""", (name, started))
    try:
        yield result
    except Exception as exc:
        result["error"] = str(exc)[:480] or type(exc).__name__
        raise
    finally:
        finished = int(time.time() * 1000)
        error = result["error"][:480]
        with get_conn() as conn:
            conn.execute("""UPDATE worker_task_status SET finished_at=?,duration_ms=?,error=?,
                success_at=CASE WHEN ?='' THEN ? ELSE success_at END,
                error_at=CASE WHEN ?<>'' THEN ? ELSE error_at END WHERE name=?""",
                (finished, (time.monotonic() - clock) * 1000, error, error, finished, error, finished, name))


def run_task(name: str, callback, *args, **kwargs):
    with task_run(name) as state:
        result = callback(*args, **kwargs)
        if isinstance(result, dict):
            errors = result.get("errors") or []
            failed = int(result.get("failed") or 0)
            if errors or failed:
                state["error"] = f"failed={failed}; " + "; ".join(map(str, errors[:5]))
        elif isinstance(result, list) and result:
            state["error"] = "; ".join(map(str, result[:5]))
        return result


def worker_task_snapshot() -> list[dict[str, Any]]:
    keys = ("name", "startedAt", "finishedAt", "lastSuccessAt", "lastErrorAt", "durationMs", "runCount", "error")
    with get_conn() as conn:
        return [dict(zip(keys, row)) for row in conn.execute("SELECT * FROM worker_task_status ORDER BY name")]


def log_event(event: str, **fields: Any) -> None:
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "event": event,
        **fields,
    }
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)
