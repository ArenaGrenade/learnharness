#!/usr/bin/env python3
"""Build inside Docker; keep large intermediate files on the selected build disk."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, default=ROOT)
parser.add_argument('--build-root', type=Path, default=Path(tempfile.gettempdir()))
parser.add_argument('--image', default='homelab-learnharness:integration')
args = parser.parse_args()
source = args.source.resolve()
args.build_root.mkdir(parents=True, exist_ok=True)
builder = 'homelab-learnharness-build:node26'
subprocess.run(['docker', 'build', '-t', builder, '-f', str(ROOT / 'deploy/docker/Builder.Dockerfile'), str(ROOT)], check=True)
with tempfile.TemporaryDirectory(prefix='learnharness-build-', dir=args.build_root) as temporary:
    stage = Path(temporary)
    context = stage / 'source'
    context.mkdir()
    ignore = shutil.ignore_patterns('node_modules', '.sdk', '.git', '.env*', 'auth.json', '*credentials.json*', '*.pem', '*.key', '__pycache__', '*.pyc')
    for name in ['app', 'components', 'lib', 'public', 'scripts', 'skills', 'src', 'tests', 'plugins', 'examples', 'docs', 'electron', 'build', 'deploy']:
        if (source / name).exists():
            shutil.copytree(source / name, context / name, ignore=ignore)
    for name in ['package.json', 'package-lock.json', 'config.ts', 'next.config.ts', 'tsconfig.json', 'next-env.d.ts', 'postcss.config.mjs', 'components.json', 'proxy.ts', 'instrumentation.ts', 'LICENSE', 'core-plugins.json', 'eslint.config.mjs', 'UPSTREAM.md', 'AGENTS.md', 'README.md']:
        if (source / name).exists():
            shutil.copy2(source / name, context / name)
    cache = stage / 'npm-cache'
    cache.mkdir()
    command = 'npm ci && npm run plugins:setup && npm run build && node scripts/build-server.mjs'
    subprocess.run(['docker', 'run', '--rm', '--user', f'{os.getuid()}:{os.getgid()}', '--cpus', '4', '--memory', '6g', '--pids-limit', '1024',
                    '--mount', f'type=bind,src={context},dst=/app', '--mount', f'type=bind,src={cache},dst=/npm-cache',
                    '-e', 'npm_config_cache=/npm-cache', '-e', 'LH_DATA_DIR=/tmp/lh-build-data', '-e', 'LH_AUTH_FILE=/tmp/lh-build-auth.json',
                    '--entrypoint', 'sh', builder, '-c', command], check=True)
    payload = context / '.next/standalone'
    if not (payload / 'server.js').is_file():
        raise RuntimeError('Standalone build did not produce server.js')
    # Source remains credential-free; the upstream curation also rejects traced secrets.
    subprocess.run(['docker', 'build', '-t', args.image, '-f', str(ROOT / 'deploy/docker/Dockerfile'), str(payload)], check=True)
