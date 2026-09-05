import unittest

from backend.deployment import deployment_plan


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
