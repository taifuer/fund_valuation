"""Serial, project-scoped deployment. Dry-run by default; never restores a live DB."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen

from .storage import SCHEMA_VERSION


SERVICES = ('backend', 'worker', 'frontend', 'db-tools')


def deployment_plan(project: str, stamp: str) -> list[list[str]]:
    compose = ['docker', 'compose', '-p', project]
    tools = compose + ['--profile', 'tools', 'run', '--rm', '--no-deps', 'db-tools', 'python', '-m', 'backend.db_admin']
    backup = f'/app/backups/pre-deploy-{stamp}.db'
    return [
        *[compose + ['build', service] for service in SERVICES],
        compose + ['stop', '-t', '60', 'worker', 'backend'],
        tools + ['backup', '--output', backup],
        tools + ['verify-backup', backup],
        tools + ['migrate'],
        compose + ['up', '-d', '--no-deps', '--no-build', '--wait', '--wait-timeout', '90', 'backend'],
        compose + ['up', '-d', '--no-deps', '--no-build', 'frontend'],
        compose + ['up', '-d', '--no-deps', '--no-build', 'worker'],
    ]


def run(command: list[str]) -> str:
    # Do not print resolved Compose configuration, environment or credentials.
    return subprocess.run(command, check=True, text=True, stdout=subprocess.PIPE, timeout=900).stdout.strip()


def verify_site(url: str) -> None:
    for route in ('/api/ready', '/api/meta', '/', '/funds', '/returns', '/risk', '/companies', '/about'):
        with urlopen(url.rstrip('/') + route, timeout=15) as response:
            body = response.read()
        if route == '/api/ready' and not json.loads(body).get('ready'):
            raise RuntimeError('Backend readiness failed')
        if not route.startswith('/api/') and b'id="root"' not in body:
            raise RuntimeError(f'SPA route failed: {route}')


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', required=True)
    parser.add_argument('--commit', help='Required exact checked-out Git commit for a deployment')
    parser.add_argument('--url', default='http://127.0.0.1:8080')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--rollback', type=Path, help='Manifest for image-only rollback; newer DB schema is refused')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', args.project):
        parser.error('Invalid Compose project name')
    compose = ['docker', 'compose', '-p', args.project]
    stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
    if args.rollback:
        manifest = json.loads(args.rollback.read_text())
        if manifest['project'] != args.project or set(manifest['images']) != set(SERVICES):
            parser.error('Rollback manifest does not match project/services')
        if not all(re.fullmatch(r'sha256:[a-f0-9]{64}', image) for image in manifest['images'].values()):
            parser.error('Rollback requires immutable image IDs')
        if not args.execute:
            print('Plan: check DB compatibility, stop writers, restore saved project images, verify routes. No database restore.')
            return
        status = json.loads(run(compose + ['--profile', 'tools', 'run', '--rm', '--no-deps', 'db-tools', 'python', '-m', 'backend.db_admin', 'status']))
        for service in ('backend', 'worker', 'db-tools'):
            version = int(run(['docker', 'run', '--rm', '--network', 'none', '--entrypoint', 'python', manifest['images'][service], '-c', 'from backend.storage import SCHEMA_VERSION; print(SCHEMA_VERSION)']))
            if int(status['schemaVersion']) > version:
                raise RuntimeError('Database schema is newer than rollback images. Manual reviewed restore is required; nothing restarted.')
        override = args.rollback.with_suffix('.override.json')
        override.write_text(json.dumps({'services': {name: {'image': value} for name, value in manifest['images'].items()}}))
        run(compose + ['stop', '-t', '60', 'worker', 'backend'])
        rollback_compose = compose + ['-f', 'docker-compose.yml', '-f', str(override)]
        for service in ('backend', 'frontend', 'worker'):
            run(rollback_compose + ['up', '-d', '--no-deps', '--no-build', '--wait', '--wait-timeout', '90', service])
        verify_site(args.url)
        print('Image rollback verified; database unchanged.')
        return
    if not args.commit or not re.fullmatch(r'[a-f0-9]{40}', args.commit):
        parser.error('--commit must be the full expected Git SHA')
    plan = deployment_plan(args.project, stamp)
    if not args.execute:
        print('\n'.join(' '.join(command) for command in plan))
        print('Then verify readiness and SPA routes. No Git, Docker, database or network changes made.')
        return
    if run(['git', 'rev-parse', 'HEAD']) != args.commit or run(['git', 'status', '--porcelain']):
        raise RuntimeError('Expected a clean worktree at the supplied commit')
    run(compose + ['config', '--quiet'])
    config = json.loads(run(compose + ['--profile', 'tools', 'config', '--format', 'json']))
    images = {}
    for service in SERVICES:
        containers = run(compose + ['ps', '-aq', service]).splitlines()
        if containers:
            images[service] = run(['docker', 'inspect', containers[0], '--format', '{{.Image}}'])
        else:
            reference = config['services'][service].get('image') or f'{args.project}-{service}:latest'
            images[service] = run(['docker', 'image', 'inspect', reference, '--format', '{{.Id}}'])
    destination = Path('data/deployments') / f'{stamp}.json'
    destination.parent.mkdir(parents=True, exist_ok=True)
    manifest = {'project': args.project, 'commit': args.commit, 'schema': SCHEMA_VERSION,
                'images': images, 'backup': f'/app/backups/pre-deploy-{stamp}.db', 'stage': 'preflight'}
    destination.write_text(json.dumps(manifest, indent=2))
    for service, image in images.items():
        run(['docker', 'tag', image, f'{args.project}-rollback-{service}:{stamp}'])
    try:
        for command in plan:
            print(' '.join(command), flush=True)
            run(command)
            manifest['stage'] = ' '.join(command[4:])
            destination.write_text(json.dumps(manifest, indent=2))
        time.sleep(2)
        worker_id = run(compose + ['ps', '-q', 'worker'])
        if not worker_id or run(['docker', 'inspect', worker_id, '--format', '{{.State.Running}}']) != 'true':
            raise RuntimeError('Worker is not running')
        verify_site(args.url)
        manifest['stage'] = 'verified'
        destination.write_text(json.dumps(manifest, indent=2))
        print(f'Deployment verified. Recovery manifest: {destination}')
    except Exception:
        print(f'Deployment stopped. Inspect {destination}; no automatic DB restore or image pruning performed.', flush=True)
        raise


if __name__ == '__main__':
    main()
