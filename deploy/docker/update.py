#!/usr/bin/env python3
"""Build then replace this web stack, retaining an image/profile rollback snapshot."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[2]
p = argparse.ArgumentParser()
p.add_argument('--env-file', type=Path, required=True)
p.add_argument('--state-dir', type=Path, required=True)
p.add_argument('--build-root', type=Path, required=True)
p.add_argument('--skip-build', action='store_true', help='Use images already validated and selected by the env file')
a = p.parse_args()
def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)
compose = ['docker', 'compose', '--env-file', str(a.env_file.resolve()), '-f', str(ROOT/'deploy/docker/compose.yaml')]
configuration = json.loads(run(compose+['config','--format','json'], capture_output=True, text=True).stdout)
app = configuration['services']['learnharness']
profile = Path(next(mount['source'] for mount in app['volumes'] if mount['target']=='/appdata'))
if not profile.is_dir(): raise SystemExit('Persistent profile must already exist')
backup = a.state_dir/'backups'/datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')
backup.mkdir(parents=True, mode=0o700)
os.chmod(backup,0o700)
(backup/'compose.resolved.json').write_text(json.dumps(configuration,indent=2))
os.chmod(backup/'compose.resolved.json',0o600)
shutil.copy2(a.env_file,backup/'deployment.env');os.chmod(backup/'deployment.env',0o600)
for service in ['learnharness','netguard','execution-broker']:
    result = subprocess.run(compose+['ps','-q',service],capture_output=True,text=True)
    if result.stdout.strip():
        inspection = run(['docker','inspect',result.stdout.strip()],capture_output=True,text=True).stdout
        (backup/(service+'.inspect.json')).write_text(inspection);os.chmod(backup/(service+'.inspect.json'),0o600)
        image = json.loads(inspection)[0]['Image']
        run(['docker','tag',image,'learnharness-rollback-'+service+':'+backup.name])
if not a.skip_build:
    run(['python3',str(ROOT/'deploy/docker/build.py'),'--build-root',str(a.build_root),'--image',app['image']])
    execution = configuration['services']['execution-broker']['environment']['EXECUTION_IMAGE']
    run(['docker','build','-t',execution,'-f',str(ROOT/'deploy/docker/runner/Dockerfile'),str(ROOT)])
    run(compose+['build','execution-broker','netguard'])
run(compose+['stop','learnharness'])
try:
    with tarfile.open(backup/'profile.tar.gz','w:gz') as archive:
        archive.add(profile,arcname='appdata')
except BaseException:
    run(compose+['start','learnharness'])
    raise
print('Rollback profile, configuration and image references:',backup,flush=True)
run(compose+['up','-d','--force-recreate','--wait','--wait-timeout','180'])
print('Deployment healthy. Retain the rollback snapshot until accepted.')
