"""Read-only, forward-observation report. Never trains or rewrites forecasts."""
from __future__ import annotations

import argparse
import json
import sqlite3
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path


def valuation_quality_report(path: Path, *, days: int = 90, as_of: date | None = None) -> dict:
    end = as_of or date.today()
    start = (end - timedelta(days=max(1, days) - 1)).isoformat()
    groups = defaultdict(list)
    excluded = 0
    with sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("""
            SELECT s.*, (SELECT MAX(h.date) FROM fund_nav_history h
              WHERE h.code=s.code AND h.date<s.target_date) AS previous_nav_date
            FROM fund_estimate_snapshots s WHERE target_date BETWEEN ? AND ?
            ORDER BY code,target_date,model_version,input_signature,
              CASE estimate_kind WHEN 'pending' THEN 0 ELSE 1 END,as_of DESC
        """, (start, end.isoformat())).fetchall()
    seen = set()
    for row in rows:
        if not row['complete'] or row['actual_change'] is None or row['comparison_date'] != row['previous_nav_date'] or not row['input_signature']:
            excluded += 1
            continue
        identity = (row['code'], row['target_date'], row['model_version'], row['input_signature'])
        if identity in seen:
            continue
        seen.add(identity)
        groups[(row['code'], row['model_version'], row['input_signature'])].append(row)
    summaries = []
    for (code, model, signature), samples in sorted(groups.items()):
        errors = [float(row['estimated_change']) - float(row['actual_change']) for row in samples]
        missing = []
        for row in samples:
            details = json.loads(row['details_json'])
            weight = details.get('disclosedWeight')
            if isinstance(weight, (int, float)):
                missing.append(max(weight - row['coverage'], 0) * 100)
        summaries.append({
            'code': code, 'modelVersion': model, 'inputSignature': signature,
            'sampleCount': len(samples), 'startDate': samples[0]['target_date'], 'endDate': samples[-1]['target_date'],
            'maePp': round(sum(map(abs, errors)) / len(errors), 4),
            'biasPp': round(sum(errors) / len(errors), 4),
            'averageMissingDisclosedWeightPp': round(sum(missing) / len(missing), 4) if missing else None,
            'missingWeightSampleCount': len(missing),
            'calibrationEligible': len(samples) >= 30,
        })
    return {'startDate': start, 'endDate': end.isoformat(), 'sampleCount': len(seen),
            'excludedCount': excluded, 'groups': summaries, 'units': 'percentage points',
            'calibrationNote': '30 samples only permits evaluation; chronological holdout must still pass'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--days', type=int, default=90)
    args = parser.parse_args()
    print(json.dumps(valuation_quality_report(args.database, days=args.days), indent=2))


if __name__ == '__main__':
    main()
