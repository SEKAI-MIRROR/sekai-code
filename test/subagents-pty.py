"""Exercise concurrent worker approvals and cancellation in a real terminal."""
import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ENTRY = Path(os.environ.get('SEKAI_TUI_ENTRY', Path(__file__).resolve().parents[1] / 'cli/main.js'))
slow_started = threading.Event()
parent_calls = 0
worker_calls = {}

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        global parent_calls
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        match = re.search(r'You are sub-agent (Alpha|Beta|Slow)\.', body['messages'][0]['content'])
        worker = match.group(1) if match else None
        def call(name, args, index=0):
            return {'index': index, 'id': f'{worker or "parent"}-{name}-{index}', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}
        reason = 'tool_calls'
        if worker:
            worker_calls[worker] = worker_calls.get(worker, 0) + 1
            if worker == 'Slow':
                slow_started.set()
                delta = {'content': 'Should have been cancelled.'}
                reason = 'stop'
            elif worker_calls[worker] == 1:
                delta = {'tool_calls': [call('write_file', {'path': worker + '.txt', 'content': worker})]}
            else:
                delta = {'content': worker + ' report.'}
                reason = 'stop'
        else:
            parent_calls += 1
            if parent_calls == 1:
                delta = {'tool_calls': [call('spawn_agent', {'name': name, 'task': 'Create ' + name + '.txt'}, i) for i, name in enumerate(['Alpha', 'Beta'])]}
            elif parent_calls in (2, 5):
                delta = {'tool_calls': [call('wait_agents', {})]}
            elif parent_calls == 4:
                delta = {'tool_calls': [call('spawn_agent', {'name': 'Slow', 'task': 'Wait for cancellation.'})]}
            else:
                delta = {'content': 'All agents finished.'}
                reason = 'stop'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        try:
            if worker == 'Slow':
                time.sleep(2)
            for event in [{'choices': [{'delta': delta, 'finish_reason': reason}]}, {'choices': [], 'usage': {'total_tokens': 5, 'prompt_tokens': 3, 'completion_tokens': 2}}]:
                self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
                self.wfile.flush()
            self.wfile.write(b'data: [DONE]\n\n')
        except (BrokenPipeError, ConnectionResetError):
            pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory(prefix='sekai-workers-pty-') as root:
    env = {**os.environ, 'TERM': 'xterm-256color', 'SEKAI_HOME': root + '/state', 'SEKAI_API_KEY': 'test-only'}
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 110, 0, 0))
    initial = termios.tcgetattr(slave)
    child = subprocess.Popen(['node', str(ENTRY), '-C', root, '--base-url', f'http://127.0.0.1:{server.server_port}', '-m', 'test', '--max-agents', '2'], stdin=slave, stdout=slave, stderr=slave, env=env)
    log = bytearray()
    def send(text):
        os.write(master, text.encode())
    def expect(needle, start=None):
        start = len(log) if start is None else start
        end = time.monotonic() + 12
        while needle.encode() not in log[start:] and time.monotonic() < end:
            if select.select([master], [], [], .1)[0]:
                log.extend(os.read(master, 262144))
        assert needle.encode() in log[start:], (needle, bytes(log[start:]))
    try:
        expect('ctrl+j newline', 0)
        send('Delegate two file writes\r')
        expect('Allow write_file?')
        send('y')
        expect('Allow write_file?')
        send('y')
        expect('All agents finished.')
        assert Path(root, 'Alpha.txt').read_text() == 'Alpha'
        assert Path(root, 'Beta.txt').read_text() == 'Beta'
        send('/agents\r')
        expect('Alpha · completed')
        send('Delegate a slow task\r')
        assert slow_started.wait(8)
        send('/agents\r')
        expect('Slow · running')
        send('\x1b')
        expect('Stopped. Session saved.')
        send('/q\r')
        expect('\x1b[?1049l')
        child.wait(timeout=5)
        while select.select([master], [], [], .05)[0]:
            log.extend(os.read(master, 262144))
        assert child.returncode == 0
        assert termios.tcgetattr(slave) == initial
        after_exit = bytes(log).rsplit(b'\x1b[?1049l', 1)[-1]
        assert not re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', after_exit).strip()
        saved = [json.loads(p.read_text()) for p in Path(root, 'state/sessions').glob('*.json')]
        parent = next(s for s in saved if not s.get('parentId'))
        assert [a['status'] for a in parent['subagents']] == ['completed', 'completed', 'cancelled']
        assert not any('test-only' in json.dumps(s) for s in saved)
        print('Worker PTY passed: concurrent tasks, two approvals, live /agents, real edits, Esc cancels workers, /q restores shell.')
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
        os.close(slave)
        server.shutdown()
