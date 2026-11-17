"""Compare direct HTTP fingerprints with a held loopback listener and curl."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import socket
import subprocess
import threading

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Length', '8')
        self.end_headers()
        self.wfile.write(b'w9-probe')
    def log_message(self, *args):
        pass

def fingerprint(raw):
    headers, _, body = raw.partition(b'\r\n\r\n')
    lines = headers.decode(errors='replace').split('\r\n')
    allowed = ('server:', 'content-type:', 'proxy-authenticate:', 'content-length:')
    return {'status': lines[0], 'headers': [line for line in lines[1:] if line.lower().startswith(allowed)], 'body_sha256': hashlib.sha256(body).hexdigest()}

for port in (58994, 58999, 59159, 62219):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=1) as client:
            client.sendall(b'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
            raw = b''
            while chunk := client.recv(4096):
                raw += chunk
            print('candidate', port, json.dumps(fingerprint(raw)), flush=True)
    except OSError as error:
        print('candidate', port, type(error).__name__, flush=True)
failures = []
for iteration in range(100):
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01})
    thread.start()
    try:
        result = subprocess.run(['curl', '--silent', '--show-error', '--max-time', '2', '--include', f'http://127.0.0.1:{server.server_port}/'], capture_output=True)
        if result.returncode or not result.stdout.endswith(b'w9-probe'):
            failures.append({'iteration': iteration, 'exit': result.returncode, 'response': fingerprint(result.stdout)})
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
print(json.dumps({'trials': 100, 'failures': failures}), flush=True)
