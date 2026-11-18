"""Private, narrow Docker broker. Only this service has the daemon socket."""
import base64
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import struct
import threading
import time
import uuid

IMAGE = os.environ['EXECUTION_IMAGE']
TOKEN = os.environ['EXECUTION_TOKEN']
if len(TOKEN) < 32:
    raise RuntimeError('An execution token of at least 32 characters is required')
LANGUAGES = json.loads(Path('/opt/runner/languages.json').read_text())
JOBS = threading.BoundedSemaphore(2)
GPU = threading.BoundedSemaphore(1)
CACHE = None
CACHE_UNTIL = 0
PROBE_LOCK = threading.Lock()


class DockerConnection(http.client.HTTPConnection):
    def __init__(self, timeout=45):
        super().__init__('localhost', timeout=timeout)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect('/var/run/docker.sock')


def docker(method, path, value=None, raw=False):
    connection = DockerConnection()
    body = None if value is None else json.dumps(value)
    try:
        connection.request(method, '/v1.47' + path, body=body, headers={'Content-Type': 'application/json'})
        response = connection.getresponse()
        data = response.read(262144)
        if response.status >= 300:
            raise RuntimeError('Execution engine rejected operation (HTTP %d)' % response.status)
        return data if raw else json.loads(data) if data else None
    finally:
        connection.close()


def run(request, gpu=False):
    if not JOBS.acquire(timeout=1):
        raise RuntimeError('Execution queue is busy; retry shortly')
    gpu_claimed = False
    container = None
    try:
        if gpu:
            gpu_claimed = GPU.acquire(timeout=1)
            if not gpu_claimed:
                raise RuntimeError('CUDA runner is busy; retry shortly')
        config = {
            'Image': IMAGE, 'Entrypoint': ['python3', '/opt/runner/execute.py'], 'Cmd': [],
            'User': '65534:65534', 'WorkingDir': '/work', 'NetworkDisabled': True,
            'Env': ['LH_EXECUTION_REQUEST=' + base64.b64encode(json.dumps(request).encode()).decode(), 'NVIDIA_DRIVER_CAPABILITIES=compute,utility'],
            'Labels': {'learnharness.execution': '1', 'learnharness.expires': str(int(time.time()) + 60)},
            'HostConfig': {
                'NetworkMode': 'none', 'ReadonlyRootfs': True, 'CapDrop': ['ALL'],
                'SecurityOpt': ['no-new-privileges:true'], 'Memory': 2147483648,
                'MemorySwap': 2147483648, 'NanoCpus': 2000000000, 'PidsLimit': 128,
                'Tmpfs': {'/work': 'rw,exec,nosuid,nodev,size=268435456,mode=1777', '/tmp': 'rw,nosuid,nodev,noexec,size=134217728,mode=1777'},
                **({'DeviceRequests': [{'Driver': 'nvidia', 'Count': 1, 'Capabilities': [['gpu']]}]} if gpu else {}),
            },
        }
        container = docker('POST', '/containers/create?name=lh-code-' + uuid.uuid4().hex, config)['Id']
        docker('POST', '/containers/' + container + '/start')
        waited = docker('POST', '/containers/' + container + '/wait?condition=not-running')
        logs = docker('GET', '/containers/' + container + '/logs?stdout=1&stderr=1', raw=True)
        output = bytearray()
        while len(logs) >= 8:
            stream, length = logs[0], struct.unpack('>I', logs[4:8])[0]
            if stream == 1:
                output.extend(logs[8:8 + length])
            logs = logs[8 + length:]
        if len(output) > 200000:
            raise RuntimeError('Execution output exceeded the protocol limit')
        result = json.loads(output)
        if waited.get('StatusCode') != 0 and 'languages' in result:
            raise RuntimeError('Runner capability check failed')
        return result
    finally:
        if container:
            try:
                docker('DELETE', '/containers/' + container + '?force=1&v=1')
            except Exception:
                pass
        if gpu_claimed:
            GPU.release()
        JOBS.release()


def capabilities():
    global CACHE, CACHE_UNTIL
    with PROBE_LOCK:
        if CACHE is not None and time.monotonic() < CACHE_UNTIL:
            return CACHE
        result = run({'action': 'capabilities'})
        try:
            gpu = run({'action': 'capabilities', 'gpu': True}, gpu=True)
            cuda = next(row for row in gpu['languages'] if row['id'] == 'cuda')
            result['languages'] = [cuda if row['id'] == 'cuda' else row for row in result['languages']]
        except Exception:
            pass  # CPU compilers remain usable; CUDA retains its explicit unavailable state.
        CACHE, CACHE_UNTIL = result, time.monotonic() + 60
        return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def authorized(self):
        return hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN)

    def do_GET(self):
        if not self.authorized():
            return self.respond(401, {'error': 'Unauthorized'})
        if self.path == '/health':
            return self.respond(200, {'ready': True})
        if self.path != '/capabilities':
            return self.respond(404, {'error': 'Not found'})
        try:
            self.respond(200, capabilities())
        except Exception:
            self.respond(503, {'error': 'Execution runner unavailable'})

    def do_POST(self):
        if not self.authorized():
            return self.respond(401, {'error': 'Unauthorized'})
        if self.path != '/execute':
            return self.respond(404, {'error': 'Not found'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 65536:
                return self.respond(413, {'error': 'Execution request must be at most 64 KiB'})
            request = json.loads(self.rfile.read(length))
            if set(request) != {'language', 'answer', 'tests'}:
                raise ValueError('Invalid execution request')
            language = next((row for row in LANGUAGES if row['id'] == request['language']), None)
            tests = request['tests']
            if language is None or not isinstance(request['answer'], str) or not isinstance(tests, dict):
                raise ValueError('Unsupported language or invalid source')
            if set(tests) != {'program', 'args', 'code'} or tests['program'] != 'python3' or tests['args'] != ['-'] or not isinstance(tests['code'], str):
                raise ValueError('Only the configured Python test driver is accepted')
            status = next(row for row in capabilities()['languages'] if row['id'] == language['id'])
            if not status.get('available'):
                return self.respond(503, {'error': status.get('reason', 'Language unavailable')})
            self.respond(200, run(request, gpu=language.get('gpu', False)))
        except (ValueError, TypeError, KeyError):
            self.respond(400, {'error': 'Invalid execution request or unsupported language'})
        except Exception:
            self.respond(503, {'error': 'Execution runner unavailable or busy'})


def reap_expired_jobs():
    while True:
        try:
            from urllib.parse import quote
            filters = quote(json.dumps({'label': ['learnharness.execution=1']}))
            for container in docker('GET', '/containers/json?all=1&filters=' + filters):
                expires = int(container.get('Labels', {}).get('learnharness.expires', '0'))
                if expires and expires < time.time():
                    docker('DELETE', '/containers/' + container['Id'] + '?force=1&v=1')
        except Exception:
            pass
        time.sleep(15)


if __name__ == '__main__':
    threading.Thread(target=reap_expired_jobs, daemon=True).start()
    ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
