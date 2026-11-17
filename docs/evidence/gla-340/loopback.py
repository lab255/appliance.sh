"""Deliberate two-suite contention plus held ephemeral-port ownership survey."""
import os
import socket
import subprocess

root = 'docs/evidence/gla-340/'
# Record only command/pid/address, never the host username or HTTP response body.
survey = subprocess.check_output(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], text=True)
print('Listener survey:\n' + survey, flush=True)
ports = set()
for line in survey.splitlines():
    if line.startswith('n'):
        ports.add(int(line.rsplit(':', 1)[1]))
for port in sorted(ports):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.4) as client:
            client.sendall(b'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
            status = client.recv(256).split(b'\r\n', 1)[0]
            # Only retain HTTP status number, avoiding application/private text.
            words = status.split()
            print(f'HTTP probe port={port}: ' + (words[1].decode() if status.startswith(b'HTTP/') and len(words)>1 else 'non-HTTP response'), flush=True)
    except (OSError, TimeoutError) as error:
        print(f'HTTP probe port={port}: {type(error).__name__}', flush=True)
children = [subprocess.Popen(['python3', root+'run.py', root+f'api-concurrent-{i}.txt', 'pnpm', '--filter', '@appliance.sh/api-server', 'exec', 'vitest', 'run']) for i in (1, 2)]
collisions = 0
observations = 0
while observations < 100 or any(child.poll() is None for child in children):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        port = listener.getsockname()[1]
        result = subprocess.run(['lsof', '-nP', f'-iTCP:{port}', '-sTCP:LISTEN', '-Fp'], capture_output=True, text=True)
        pids = {int(line[1:]) for line in result.stdout.splitlines() if line.startswith('p')}
        others = pids - {os.getpid()}
        if others:
            collisions += 1
        print(f'bound port={port} owner_seen={os.getpid() in pids} other_pids={sorted(others)} suites_running={sum(c.poll() is None for c in children)}', flush=True)
    observations += 1
    if observations >= 1000:
        break
print(f'observations={observations} collisions={collisions} suite_exits={[c.wait() for c in children]}', flush=True)
