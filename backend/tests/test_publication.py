from __future__ import annotations

import copy
import gzip
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend import server, storage
from backend.db_admin import optimize_database
from backend.return_summaries import publish_return_summaries, read_return_summaries
from backend.security import configured_token, validate_security_configuration
from backend.snapshots import publish_fund_details, read_fund_detail, read_snapshot
from backend.worker import public_data_health
from backend.worker_health import worker_health


class PublicationTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix='fund-publication-test-')
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.path = self.root / 'test.db'
        self.assertTrue(self.path.is_relative_to(Path(tempfile.gettempdir())))
        for module in (server, storage):
            for name, value in [('DB_PATH', self.path), ('DATA_DIR', self.root), ('RAW_DIR', self.root / 'raw')]:
                patcher = patch.object(module, name, value)
                patcher.start()
                self.addCleanup(patcher.stop)
        storage.migrate_database(self.path)
        server._RESPONSE_CACHE.clear()
        server._RATE_LIMIT_BUCKETS.clear()

    def test_details_deduplicate_heartbeats_but_keep_price_time_and_quality(self):
        initial = {'017436': {'officialNav': 1, 'officialNavDate': '2026-10-15',
            'holdings': [{'sinaSymbol': 'gb_aapl', 'weight': .5, 'metadata': 'x' * 30000}],
            'holdingQuotes': {'gb_aapl': {'price': 250, 'quoteAsOf': 10}},
            'preview': {'asOf': 100, 'targetDate': '2026-10-16', 'changePercent': 2,
                        'holdingContributions': [{'contributionPercent': 2}]}}}
        payload = copy.deepcopy(initial)
        compact = publish_fund_details(payload, 100)
        name = compact['017436']['_detailRef']
        self.assertNotIn('holdings', compact['017436'])
        self.assertNotIn('holdingContributions', compact['017436']['preview'])
        self.assertEqual(compact['017436']['holdingSymbols'], ['gb_aapl'])
        self.assertEqual(read_fund_detail(name)['holdings'], initial['017436']['holdings'])
        self.assertEqual(read_fund_detail(name)['preview']['holdingContributions'], [{'contributionPercent': 2}])
        payload = copy.deepcopy(initial)
        payload['017436']['preview']['asOf'] = 200
        repeated = publish_fund_details(payload, 200)
        self.assertEqual(repeated['017436']['_detailRef'], name)
        self.assertEqual(read_snapshot('fund-estimates')['generatedAt'], 100)
        self.assertEqual(payload['017436']['preview']['asOf'], 100)
        payload = copy.deepcopy(initial)
        payload['017436']['holdingQuotes']['gb_aapl']['quoteAsOf'] = 20
        updated = publish_fund_details(payload, 300)
        self.assertNotEqual(updated['017436']['_detailRef'], name)
        payload['017436']['preview']['quality'] = {'stale': True}
        quality = publish_fund_details(payload, 400)
        self.assertNotEqual(quality['017436']['_detailRef'], updated['017436']['_detailRef'])
        self.assertIsNotNone(read_fund_detail(name))
        with storage.get_conn() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM dashboard_snapshots WHERE name LIKE 'fund-static:%'").fetchone()[0], 1)
            self.assertLess(conn.execute('SELECT SUM(length(payload)) FROM dashboard_snapshots').fetchone()[0], 6000)

    def test_retains_three_pinned_versions_and_supports_legacy_json(self):
        names = []
        for value in range(5):
            compact = publish_fund_details({'017436': {'holdings': [{'weight': value}],
                'preview': {'estimatedNav': value}}}, value + 1)
            names.append(compact['017436']['_detailRef'])
        self.assertIsNone(read_fund_detail(names[0]))
        for name in names[-3:]:
            self.assertIsNotNone(read_fund_detail(name))
        with storage.get_conn() as conn:
            conn.execute('INSERT INTO dashboard_snapshots VALUES (?,?,?)', ('legacy', '{"holdings":[1]}', 1))
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM dashboard_snapshots WHERE name LIKE 'fund-static:%'").fetchone()[0], 3)
        self.assertEqual(read_fund_detail('legacy')['holdings'], [1])

    def seed_market(self):
        with storage.get_conn() as conn:
            conn.executemany('INSERT INTO market_history VALUES (?,?,?,?,?)', [
                ('sina-cn', 'sh000001', '2026-10-12', 100, 1),
                ('sina-cn', 'sh000001', '2026-10-13', 105, 1)])

    def test_summary_invalidates_after_correction_not_fetch_clock(self):
        self.seed_market()
        self.assertEqual(publish_return_summaries()['published'], 1)
        with storage.get_conn() as conn:
            conn.execute('UPDATE market_history SET fetched_at=10')
        self.assertEqual(publish_return_summaries()['published'], 0)
        with storage.get_conn() as conn:
            conn.execute("UPDATE market_history SET close=110 WHERE date='2026-10-13'")
        self.assertEqual(publish_return_summaries()['published'], 1)
        summary = read_return_summaries('market', ['sina-cn:sh000001'])['sina-cn:sh000001']
        self.assertEqual(summary['latest']['returnPercent'], 10)
        with storage.get_conn() as conn:
            conn.execute('DELETE FROM market_history')
        self.assertEqual(publish_return_summaries()['published'], 1)
        self.assertEqual(read_return_summaries('market', ['sina-cn:sh000001']), {})

    def test_summary_never_labels_a_racing_calculation_as_current(self):
        self.seed_market()
        def compute(*_args):
            with storage.get_conn() as conn:
                conn.execute('UPDATE market_history SET close=close+1')
            return {'endDate': '2026-10-13'}
        with patch.object(server, 'read_market_return_summary_from_db', side_effect=compute):
            self.assertEqual(publish_return_summaries()['published'], 0)
        self.assertEqual(read_return_summaries('market', ['sina-cn:sh000001']), {})
        self.assertEqual(publish_return_summaries()['published'], 1)

    def test_summary_api_reads_only_publication_and_supports_etag(self):
        self.seed_market()
        publish_return_summaries()
        with patch.object(server, 'read_market_return_summary_from_db', side_effect=AssertionError('Request calculation')), \
                patch.object(server, 'fetch_upstream', side_effect=AssertionError('Request fetch')):
            client = server.app.test_client()
            url = '/api/marketreturns?items=sina-cn:sh000001'
            first = client.get(url)
            self.assertEqual(first.status_code, 200)
            self.assertEqual(client.get(url, headers={'If-None-Match': first.headers['ETag']}).status_code, 304)

    def test_fund_and_adjustment_revisions_follow_financial_values(self):
        with storage.get_conn() as conn:
            conn.execute("INSERT INTO fund_nav_history VALUES ('017436','2026-10-13',1,0,1)")
            before = conn.execute("SELECT revision FROM return_summary_versions WHERE kind='fund'").fetchone()[0]
            conn.execute("UPDATE fund_nav_history SET change_percent=NULL")
            self.assertEqual(conn.execute("SELECT revision FROM return_summary_versions WHERE kind='fund'").fetchone()[0], before + 1)
            conn.execute("INSERT INTO market_history VALUES ('sina-cn','sh515070','2026-10-13',1,1)")
            conn.execute("INSERT INTO market_adjustment_factors VALUES ('sh515070','2026-10-13',1,2,0,'test',1)")
            self.assertEqual(conn.execute("SELECT revision FROM return_summary_versions WHERE kind='market'").fetchone()[0], 2)
            conn.execute('UPDATE market_adjustment_factors SET fetched_at=20')
            self.assertEqual(conn.execute("SELECT revision FROM return_summary_versions WHERE kind='market'").fetchone()[0], 2)

    def test_latest_quote_survives_history_retention_and_old_inserts(self):
        with storage.get_conn() as conn:
            for bucket in [20, 10]:
                conn.execute("INSERT INTO market_quote_snapshots VALUES (?,?,?,'time','closed','test',1,1,0,'ok','','raw','sanitized')", ('test', bucket, bucket))
            self.assertEqual(conn.execute('SELECT bucket_at FROM market_quote_latest').fetchone()[0], 20)
            conn.execute('DELETE FROM market_quote_snapshots')
            self.assertEqual(conn.execute('SELECT sanitized_line FROM market_quote_latest').fetchone()[0], 'sanitized')

    def test_worker_probe_distinguishes_idle_lease_from_stopped_process(self):
        with storage.get_conn() as conn:
            conn.execute("INSERT INTO background_jobs VALUES ('data-refresh','test',200000,100000,100000,0,'',1)")
        self.assertTrue(worker_health(self.path, current_ms=100000)['healthy'])
        self.assertFalse(worker_health(self.path, current_ms=400000)['healthy'])
        missing = self.root / 'missing.db'
        self.assertFalse(worker_health(missing)['healthy'])
        self.assertFalse(missing.exists())

    def test_private_responses_and_explicit_cors_allowlist(self):
        with patch.dict(os.environ, {'FUND_VALUATION_CORS_ORIGINS': 'https://allowed.example'}):
            client = server.app.test_client()
            self.assertIn('Origin', client.get('/api/health').headers['Vary'])
            for origin, allowed in [('https://allowed.example', True), ('https://other.example', False)]:
                response = client.options('/api/fund-management/verify', headers={'Origin': origin})
                self.assertEqual('Access-Control-Allow-Origin' in response.headers, allowed)
                if allowed:
                    self.assertIn('POST', response.headers['Access-Control-Allow-Methods'])
            response = client.get('/api/status', headers={'X-Fund-Management-Token': 'test'})
            self.assertEqual(response.headers['Cache-Control'], 'private, no-store')
            self.assertIn('X-Fund-Management-Token', response.headers['Vary'])
            self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')

    def test_management_fail_closed_and_placeholder_startup_error(self):
        with patch.dict(os.environ, {'FUND_VALUATION_ENABLE_FUND_MANAGEMENT': '1',
                                   'FUND_VALUATION_FUND_MANAGEMENT_TOKEN': ''}):
            self.assertEqual(server.fund_management_mode(), 'disabled')
            self.assertEqual(server.app.test_client().get('/api/fundnav?codes=999999').status_code, 403)
        with patch.dict(os.environ, {'FUND_VALUATION_DIAGNOSTICS_TOKEN': 'replace-with-a-random-token'}):
            self.assertEqual(configured_token('FUND_VALUATION_DIAGNOSTICS_TOKEN'), '')
            with self.assertRaisesRegex(RuntimeError, 'placeholder'):
                validate_security_configuration()

    def test_public_health_drops_owner_errors_symbols_and_paths(self):
        sanitized = public_data_health({'status': 'degraded', 'updatedAt': 1,
            'backgroundRefresh': {'owner': 'private-host', 'lastError': '/secret/path', 'lastSuccessAt': 1},
            'upstream': {'issues': [{'key': 'secret'}], 'errorCount': 2}})
        self.assertEqual(sanitized['backgroundRefresh'], {'lastSuccessAt': 1})
        self.assertEqual(sanitized['upstream'], {'errorCount': 2})
        with patch.object(server, 'build_data_health_payload', side_effect=AssertionError('No request scan')):
            self.assertEqual(server.app.test_client().get('/api/datahealth').get_json()['status'], 'pending')

    def test_raw_is_gzip_and_cache_budget_preserves_history(self):
        server.write_raw('test', 'test-key', b'public data' * 1000)
        files = list((self.root / 'raw').rglob('*.gz'))
        self.assertEqual(len(files), 1)
        self.assertEqual(gzip.decompress(files[0].read_bytes()), b'public data' * 1000)
        now = server.now_ms()
        self.seed_market()
        with storage.get_conn() as conn:
            conn.executemany('INSERT INTO response_cache VALUES (?,?,?,?,?,?)', [
                ('older', 'url', 200, 'text/plain', b'a' * 10, now - 100),
                ('newer', 'url', 200, 'text/plain', b'b' * 10, now)])
        result = optimize_database(self.path, raw_dir=self.root / 'raw', response_cache_max_bytes=10)
        self.assertEqual(result['evictedResponseCacheBytes'], 10)
        with storage.get_conn() as conn:
            self.assertEqual(conn.execute('SELECT cache_key FROM response_cache').fetchall(), [('newer',)])
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM market_history').fetchone()[0], 2)

    def test_2027_verified_calendar_and_explicit_unknown_coverage(self):
        server.ensure_market_calendar_seeded(2027)
        self.assertEqual(server.market_calendar_row('us', '2027-06-18')['status'], 'holiday')
        self.assertEqual(server.market_calendar_row('us', '2027-11-26')['status'], 'half_day')
        self.assertEqual(server.market_calendar_row('jp', '2027-03-22')['status'], 'holiday')
        self.assertIn('unverified', server.market_calendar_row('cn', '2027-01-01')['source'])
        self.assertIn('cn', server.calendar_coverage(2026)['2027']['pending'])
        self.assertIn('us', server.calendar_coverage(2026)['2027']['verified'])

    def test_eastmoney_keeps_http_error_and_one_transport(self):
        with patch.object(server._EASTMONEY_SESSION, 'get') as get:
            get.return_value.content = b'rate limited'
            get.return_value.status_code = 429
            get.return_value.headers = {'Content-Type': 'text/plain'}
            self.assertEqual(server.fetch_eastmoney_body('https://example.com', {}), (b'rate limited', 429, 'text/plain'))


if __name__ == '__main__':
    unittest.main()
