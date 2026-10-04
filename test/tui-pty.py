"""Real-terminal smoke test; standard library only (Linux/macOS)."""
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ENTRY = Path(os.environ.get('SEKAI_TUI_ENTRY', Path(__file__).resolve().parents[1] / 'cli/main.js'))
requests = []

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'data': [{'id': 'cx/test-model'}, {'id': 'cx/other-model'}]}).encode())

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(body)
        number = len(requests)
        if number in (1, 3):
            filename = 'blocked.txt' if number == 1 else 'hello.js'
            delta = {'tool_calls': [{'index': 0, 'id': f'call-{number}', 'type': 'function', 'function': {
                'name': 'write_file', 'arguments': json.dumps({'path': filename, 'content': 'export const greeting = "Halo, Sekai!";\n'})}}]}
            if number == 3:
                delta['tool_calls'].extend({'index': i, 'id': f'command-{i}', 'type': 'function', 'function': {
                    'name': 'run_command', 'arguments': json.dumps({'command': f'echo auto-approved-{i}'})}} for i in (1, 2))
            reason = 'tool_calls'
        else:
            if number == 2:
                assert any(m['role'] == 'tool' and json.loads(m['content']).get('denied') for m in body['messages'])
            if number == 4:
                for i in (1, 2):
                    result = next(json.loads(m['content']) for m in body['messages'] if m.get('tool_call_id') == f'command-{i}')
                    assert result['code'] == 0 and f'auto-approved-{i}' in result['output']
            delta = {'content': 'Aksi dibatalkan.' if number == 2 else '**File berhasil dibuat.**\n\n```js\nexport const greeting = "Halo, Sekai!";\n```\n\nSemua siap.'}
            reason = 'stop'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        try:
            if number == 5:
                time.sleep(3)
            deltas = [{'content': delta['content'][i:i+7]} for i in range(0, len(delta['content']), 7)] if 'content' in delta else [delta]
            events = [{'choices': [{'index': 0, 'delta': part, 'finish_reason': None}]} for part in deltas]
            events.append({'choices': [{'index': 0, 'delta': {}, 'finish_reason': reason}], 'usage': {'total_tokens': 420}})
            for event in events:
                self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
                self.wfile.flush()
                time.sleep(.025)
            self.wfile.write(b'data: [DONE]\n\n')
        except (BrokenPipeError, ConnectionResetError):
            pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
with tempfile.TemporaryDirectory(prefix='sekai-tui-') as root:
    env = {**os.environ, 'TERM': 'xterm-256color', 'SEKAI_HOME': root + '/state', 'SEKAI_API_KEY': 'test-only'}
    env.pop('NO_COLOR', None)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 38, 104, 0, 0))
    initial = termios.tcgetattr(slave)
    child = subprocess.Popen(['node', str(ENTRY), '-C', root, '--base-url', f'http://127.0.0.1:{server.server_port}', '-m', 'cx/test-model'], stdin=slave, stdout=slave, stderr=slave, env=env)
    log = bytearray()

    def expect(needle, start=None):
        start = len(log) if start is None else start
        end = time.monotonic() + 12
        while needle.encode() not in log[start:] and time.monotonic() < end:
            if select.select([master], [], [], .1)[0]:
                try:
                    log.extend(os.read(master, 262144))
                except OSError:
                    break
        assert needle.encode() in log[start:], f'Missing {needle!r}: {bytes(log[start:])!r}'

    def send(text):
        os.write(master, text.encode())

    try:
        expect('ctrl+j newline', 0)
        send('/help\r')
        expect('Tab complete')
        send('Buat file contoh.\r')
        expect('Allow write_file?')
        send('\r')  # default is deny
        expect('Aksi dibatalkan.')
        assert not Path(root, 'blocked.txt').exists()
        send('Buat hello.js untuk menyapa pengguna.\r')
        expect('Allow write_file?')
        send('\x1b[B\x1b[B\r')  # explicitly select Auto-approve session
        expect('Semua siap.')
        assert b'Auto-approve enabled (full)' in log
        assert b'Allow run_command?' not in log
        time.sleep(.15)
        assert log.count(b'\x1b[2J') <= 2, 'Streaming cleared the fullscreen viewport'
        assert b'\x1b[3J' not in log, 'Streaming replayed the scrollback buffer'
        assert Path(root, 'hello.js').read_text() == 'export const greeting = "Halo, Sekai!";\n'
        # Capture the real terminal stream for optional visual review.
        if env.get('SEKAI_TUI_CAPTURE'):
            Path(env['SEKAI_TUI_CAPTURE']).write_bytes(log)
        send('/model\r')
        expect('Select model')
        send('other\r')
        expect('Model: cx/other-model')
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 48, 0, 0))
        child.send_signal(signal.SIGWINCH)
        send('Start a slow task\r')
        deadline = time.monotonic() + 5
        while len(requests) < 5 and time.monotonic() < deadline:
            time.sleep(.03)
        assert len(requests) == 5
        send('\x1b')
        expect('Stopped. Session saved.')
        send('/q\r')
        expect('\x1b[?1049l')
        child.wait(timeout=5)
        while select.select([master], [], [], .05)[0]:
            log.extend(os.read(master, 262144))
        after_exit = bytes(log).rsplit(b'\x1b[?1049l', 1)[-1]
        assert not re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', after_exit).strip(), 'TUI printed editor/footer after restoring the shell'
        assert child.returncode == 0
        assert termios.tcgetattr(slave) == initial, 'Terminal raw mode was not restored'
        saved = list(Path(root, 'state/sessions').glob('*.json'))
        assert saved and 'test-only' not in saved[0].read_text()
        print('PTY passed: startup, help, deny/allow, real file write, streaming, model picker, resize, interrupt, exit, terminal restoration.')
    finally:
        if child.poll() is None:
            child.kill()
            child.wait()
        os.close(master)
        os.close(slave)
        server.shutdown()
