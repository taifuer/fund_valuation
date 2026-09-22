import unittest
import json
import os
from pathlib import Path
import tempfile
from unittest.mock import patch

from backend.deployment import deployment_plan, main


class DeploymentTests(unittest.TestCase):
    def test_serial_project_scoped_plan_backs_up_before_migration(self):
        plan = deployment_plan('fund_test', 'test-stamp')
        self.assertEqual([row[-1] for row in plan[:4]], ['backend', 'worker', 'frontend', 'db-tools'])
        self.assertTrue(all(row[:4] == ['docker', 'compose', '-p', 'fund_test'] for row in plan))
        flattened = [' '.join(row) for row in plan]
        backup = next(i for i, row in enumerate(flattened) if ' backup --output ' in row)
        verify = next(i for i, row in enumerate(flattened) if ' verify-backup ' in row)
        migrate = next(i for i, row in enumerate(flattened) if row.endswith(' migrate'))
        self.assertLess(backup, verify)
        self.assertLess(verify, migrate)
        self.assertFalse(any('prune' in row or ' down ' in row or ' restore ' in row for row in flattened))

    def run_deployment(self, *, site_failure=False, cleanup_failure=False):
        calls = []
        sha = 'a' * 40

        def run(command):
            calls.append(' '.join(command))
            if command == ['git', 'rev-parse', 'HEAD']:
                return sha
            if '--format' in command and 'json' in command:
                return json.dumps({'services': {name: {} for name in ('backend', 'worker', 'frontend', 'db-tools')}})
            if command[:3] == ['docker', 'image', 'inspect']:
                return 'sha256:' + 'b' * 64
            if command[-3:] == ['ps', '-q', 'worker']:
                return 'worker-id'
            if command[-1] == '{{.State.Running}}':
                return 'true'
            if 'prune-backups' in command and cleanup_failure:
                raise RuntimeError('backup verification failed')
            return ''

        def verify(url):
            calls.append('SITE VERIFIED')
            if site_failure:
                raise RuntimeError('site unavailable')

        with tempfile.TemporaryDirectory(prefix='fund-deployment-test-') as directory:
            root = Path(directory)
            self.assertTrue(root.is_relative_to(Path(tempfile.gettempdir())))
            previous = Path.cwd()
            os.chdir(root)
            try:
                with patch('backend.deployment.run', side_effect=run), \
                     patch('backend.deployment.verify_site', side_effect=verify), \
                     patch('backend.deployment.time.sleep'), \
                     patch('sys.argv', ['deployment', '--project', 'fund_test', '--commit', sha, '--execute']):
                    if site_failure:
                        with self.assertRaisesRegex(RuntimeError, 'site unavailable'):
                            main()
                    else:
                        main()
                        manifest = json.loads(next((root / 'data/deployments').glob('*.json')).read_text())
                        self.assertEqual(manifest['stage'], 'verified')
            finally:
                os.chdir(previous)
        return calls

    def test_deployment_retention_runs_only_after_successful_site_verification(self):
        calls = self.run_deployment()
        cleanup = next(i for i, command in enumerate(calls) if 'prune-backups' in command)
        self.assertGreater(cleanup, calls.index('SITE VERIFIED'))
        self.assertTrue(calls[cleanup].endswith('--kind deployment --max-files 1'))

    def test_failed_deployment_keeps_previous_backups(self):
        calls = self.run_deployment(site_failure=True)
        self.assertFalse(any('prune-backups' in command for command in calls))

    def test_cleanup_failure_does_not_invalidate_successful_deployment(self):
        self.run_deployment(cleanup_failure=True)
