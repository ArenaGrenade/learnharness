"""Exercise the real private broker without printing its token."""
import json
from pathlib import Path
import subprocess
import sys

BROKER = sys.argv[1] if len(sys.argv) > 1 else 'lh-execution-integration'
CLIENT = '''import json,os,sys,urllib.request,urllib.error
value=json.load(sys.stdin)
request=urllib.request.Request('http://127.0.0.1:8080'+value['path'],data=json.dumps(value['body']).encode() if 'body' in value else None,headers={'Authorization':'Bearer '+os.environ['EXECUTION_TOKEN'],'Content-Type':'application/json'})
try:
 response=urllib.request.urlopen(request,timeout=100)
 print(json.dumps({'status':response.status,'value':json.load(response)}))
except urllib.error.HTTPError as error:
 print(json.dumps({'status':error.code,'value':json.load(error)}))
'''


def call(path, body=None):
    value = {'path': path, **({'body': body} if body is not None else {})}
    result = subprocess.run(['docker', 'exec', '-i', BROKER, 'python3', '-c', CLIENT], input=json.dumps(value), text=True, capture_output=True, timeout=110, check=True)
    return json.loads(result.stdout)


capabilities = call('/capabilities')
assert capabilities['status'] == 200, capabilities
rows = capabilities['value']['languages']
assert {row['id'] for row in rows} == {'python', 'cuda', 'cpp', 'rust'}
assert all(row['available'] for row in rows), rows
print('PASS: compiler and GPU self-tests:', ', '.join(row['label'] for row in rows))

examples = {
    'python': ('def square(x): return x*x', "exec(open('answer.txt').read()); assert square(7)==49"),
    'cpp': ('#include <iostream>\nint main(){std::cout << 49;}', "import pathlib,subprocess;pathlib.Path('main.cpp').write_text(open('answer.txt').read());subprocess.run(['g++','main.cpp','-o','main'],check=True);assert subprocess.check_output(['./main']).strip()==b'49'"),
    'rust': ('fn main(){println!("{}",7*7);}', "import pathlib,subprocess;pathlib.Path('main.rs').write_text(open('answer.txt').read());subprocess.run(['rustc','main.rs','-o','main'],check=True);assert subprocess.check_output(['./main']).strip()==b'49'"),
    'cuda': ('#include <cuda_runtime.h>\n__global__ void k(int*p){*p=49;}\nint main(){int*p=0,v=0;if(cudaMalloc(&p,sizeof(int)))return 1;k<<<1,1>>>(p);if(cudaMemcpy(&v,p,sizeof(int),cudaMemcpyDeviceToHost))return 2;cudaFree(p);return v==49?0:3;}', "import pathlib,subprocess;pathlib.Path('main.cu').write_text(open('answer.txt').read());subprocess.run(['nvcc','main.cu','-o','main'],check=True);subprocess.run(['./main'],check=True)"),
}
for language, (answer, driver) in examples.items():
    result = call('/execute', {'language': language, 'answer': answer, 'tests': {'program': 'python3', 'args': ['-'], 'code': driver}})
    assert result['status'] == 200 and result['value']['status'] == 'passed', result
    print('PASS:', language, 'actual submission execution')

checks = """import os,pathlib,socket
assert os.getuid()!=0
assert not pathlib.Path('/appdata').exists()
assert not pathlib.Path('/var/run/docker.sock').exists()
assert not any('TOKEN' in key or 'API_KEY' in key for key in os.environ)
try:
 pathlib.Path('/outside-work').write_text('forbidden')
except PermissionError: pass
except OSError: pass
else: raise AssertionError('root filesystem writable')
s=socket.socket();s.settimeout(1)
try: s.connect(('1.1.1.1',80))
except OSError: pass
else: raise AssertionError('unexpected network access')
"""
result = call('/execute', {'language': 'python', 'answer': '', 'tests': {'program': 'python3', 'args': ['-'], 'code': checks}})
assert result['status'] == 200 and result['value']['status'] == 'passed', result
print('PASS: non-root, read-only root, no app data/socket/credentials, no network')
assert call('/execute', {'language': 'javascript', 'answer': '', 'tests': {'program': 'python3', 'args': ['-'], 'code': 'pass'}})['status'] == 400
assert call('/execute', {'language': 'python', 'answer': '', 'tests': {'program': 'sh', 'args': ['-c'], 'code': 'true'}})['status'] == 400
print('PASS: unsupported language and arbitrary executable refused')

large = call('/execute', {'language': 'python', 'answer': '', 'tests': {'program': 'python3', 'args': ['-'], 'code': "import sys;sys.stdout.write('x'*100000);sys.stderr.write('y'*100000)"}})
assert large['status'] == 200 and large['value']['status'] == 'passed', large
assert len(large['value']['stdout']) == 65536 and large['value']['stdoutTruncated']
assert len(large['value']['stderr']) == 65536 and large['value']['stderrTruncated']
print('PASS: output bounded to 64 KiB per stream')
import time
started = time.monotonic()
timeout = call('/execute', {'language': 'python', 'answer': '', 'tests': {'program': 'python3', 'args': ['-'], 'code': "import time;time.sleep(120)"}})
assert timeout['status'] == 200 and timeout['value']['status'] == 'error', timeout
assert 'timeout' in timeout['value'].get('message', '')
assert 29 <= time.monotonic() - started < 45
assert not subprocess.check_output(['docker', 'ps', '-aq', '--filter', 'label=learnharness.execution=1']).strip()
print('PASS: 30-second deadline kills execution and removes job containers')
