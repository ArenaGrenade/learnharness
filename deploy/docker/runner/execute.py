"""Trusted container entrypoint. No provider credentials or app data enter here."""
import base64
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import time

LIMIT = 65536
LANGUAGES = json.loads(Path('/opt/runner/languages.json').read_text())
ENV = {'PATH': '/usr/local/cuda/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/work', 'TMPDIR': '/tmp', 'PYTHONDONTWRITEBYTECODE': '1'}


def capabilities(gpu):
    rows = []
    for language in LANGUAGES:
        row = {k: v for k, v in language.items() if k != 'probe'}
        try:
            probe = subprocess.run(language['probe'], capture_output=True, text=True, timeout=10, env=ENV)
            row.update(compilerAvailable=probe.returncode == 0, version=(probe.stdout or probe.stderr).strip()[:1024])
        except (OSError, subprocess.TimeoutExpired) as error:
            row.update(compilerAvailable=False, version=None, reason=str(error)[:200])
        row['available'] = row['compilerAvailable']
        if language.get('gpu'):
            row['gpuAvailable'] = False
            if gpu and row['compilerAvailable']:
                Path('/work/probe.cu').write_text('#include <cuda_runtime.h>\n__global__ void k(int*p){*p=42;}\nint main(){int*p=0,v=0;if(cudaMalloc(&p,sizeof(int)))return 1;k<<<1,1>>>(p);if(cudaMemcpy(&v,p,sizeof(int),cudaMemcpyDeviceToHost))return 2;cudaFree(p);return v==42?0:3;}\n')
                compile_run = subprocess.run(['nvcc', '/work/probe.cu', '-o', '/work/probe'], capture_output=True, timeout=25, env=ENV)
                if compile_run.returncode == 0:
                    check = subprocess.run(['/work/probe'], capture_output=True, timeout=10, env=ENV)
                    row['gpuAvailable'] = check.returncode == 0
                row['available'] = row['gpuAvailable']
            else:
                row['available'] = False
            if not row['available']:
                row['reason'] = 'CUDA GPU execution has not passed its container self-test.'
        rows.append(row)
    return {'languages': rows}


def execute(request):
    language = next((row for row in LANGUAGES if request.get('language') == row['id']), None)
    if language is None:
        raise ValueError('Unsupported language')
    tests = request.get('tests', {})
    if tests.get('program') != 'python3' or tests.get('args') != ['-']:
        raise ValueError('Test drivers must use python3 with args ["-"]. Compilers run inside this driver.')
    Path('/work/answer.txt').write_text(request['answer'], encoding='utf8')
    # The request is only input data; remove it before launching submitted code.
    process = subprocess.Popen(['python3', '-'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd='/work', env=ENV, start_new_session=True)
    streams = selectors.DefaultSelector()
    for pipe, name in [(process.stdout, 'stdout'), (process.stderr, 'stderr')]:
        os.set_blocking(pipe.fileno(), False)
        streams.register(pipe, selectors.EVENT_READ, name)
    code = tests['code'].encode('utf8')
    os.set_blocking(process.stdin.fileno(), False)
    streams.register(process.stdin, selectors.EVENT_WRITE, 'input')
    data = {'stdout': bytearray(), 'stderr': bytearray()}
    truncated = {'stdout': False, 'stderr': False}
    deadline = time.monotonic() + 30
    timed_out = False
    try:
        while streams.get_map():
            if time.monotonic() >= deadline:
                timed_out = True
                break
            for key, _ in streams.select(timeout=0.1):
                if key.data == 'input':
                    try:
                        sent = os.write(key.fileobj.fileno(), code[:8192])
                        code = code[sent:]
                    except (BrokenPipeError, OSError):
                        code = b''
                    if not code:
                        streams.unregister(key.fileobj)
                        key.fileobj.close()
                    continue
                chunk = os.read(key.fileobj.fileno(), 8192)
                if not chunk:
                    streams.unregister(key.fileobj)
                    key.fileobj.close()
                else:
                    remaining = LIMIT - len(data[key.data])
                    data[key.data].extend(chunk[:remaining])
                    truncated[key.data] |= len(chunk) > remaining
        if timed_out:
            os.killpg(process.pid, signal.SIGKILL)
        exit_code = process.wait(timeout=2)
    finally:
        streams.close()
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return {'status': 'error' if timed_out else 'passed' if exit_code == 0 else 'failed', 'exitCode': exit_code, 'stdout': data['stdout'].decode('utf8', errors='ignore'), 'stderr': data['stderr'].decode('utf8', errors='ignore'), 'stdoutTruncated': truncated['stdout'], 'stderrTruncated': truncated['stderr'], **({'message': 'Test process exceeded the 30 second timeout'} if timed_out else {})}


try:
    request = json.loads(base64.b64decode(os.environ.pop('LH_EXECUTION_REQUEST')))
    if request.get('action') == 'capabilities':
        result = capabilities(request.get('gpu') is True)
    else:
        result = execute(request)
    print(json.dumps(result))
except Exception as error:
    print(json.dumps({'status': 'error', 'exitCode': None, 'stdout': '', 'stderr': '', 'stdoutTruncated': False, 'stderrTruncated': False, 'message': str(error)[:500]}))
    raise SystemExit(1)
