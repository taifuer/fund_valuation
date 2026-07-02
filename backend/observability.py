from __future__ import annotations

import json
import threading
import time
from collections import Counter
from datetime import datetime, timezone
from typing import Any


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

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            count = self._request_count
            routes = [
                {
                    "route": route,
                    "count": route_count,
                    "averageDurationMs": round(self._route_duration_ms[route] / route_count, 1),
                }
                for route, route_count in self._route_counts.most_common(20)
            ]
            return {
                "processStartedAt": self._started_at,
                "requestCount": count,
                "averageDurationMs": round(self._total_duration_ms / count, 1) if count else 0.0,
                "maxDurationMs": round(self._max_duration_ms, 1),
                "statusCounts": dict(self._status_counts),
                "cacheCounts": dict(self._cache_counts),
                "routes": routes,
            }


REQUEST_METRICS = RequestMetrics()


def log_event(event: str, **fields: Any) -> None:
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "event": event,
        **fields,
    }
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)
