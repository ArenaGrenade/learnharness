#!/usr/bin/env python3
"""Prepare an upstream merge in a worktree; never replaces production."""
import argparse
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--ref', default='origin/main')
parser.add_argument('--worktree', type=Path)
args = parser.parse_args()
def git(*arguments, check=True, cwd=ROOT):
    return subprocess.run(['git', *arguments], cwd=cwd, text=True, capture_output=True, check=check)
if git('status', '--porcelain').stdout.strip():
    raise SystemExit('Commit or otherwise preserve local changes before preparing an upstream upgrade.')
git('fetch', 'origin')
revision = git('rev-parse', '--verify', args.ref + '^{commit}').stdout.strip()
stamp = datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
branch = 'integrate-upstream-' + stamp
worktree = (args.worktree or Path(tempfile.gettempdir()) / branch).resolve()
git('worktree', 'add', '-b', branch, str(worktree), 'HEAD')
result = git('merge', '--no-ff', '--no-commit', revision, cwd=worktree, check=False)
print(result.stdout, result.stderr)
print('Integration branch:', branch)
print('Workspace:', worktree)
print('Upstream revision:', revision)
print('Resolve/review the merge, then run npm ci, npm run plugins:setup, npm test, npm run lint, npx tsc --noEmit, and deploy/docker/build.py.')
print('Production was not changed. Follow UPSTREAM.md before deployment.')
if result.returncode not in (0, 1):
    raise SystemExit(result.returncode)
