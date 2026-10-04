"""Resume saved chats through the real CLI, using isolated state and a mock provider."""
import fcntl
import json
import os
import pty
import select
import struct
import subprocess
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ENTRY = Path(__file__).resolve().parents[1] / 'cli/main.js'
requests = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(body)
        if body['messages'][-1]['role'] == 'user':
            delta = {'tool_calls': [{'index': 0, 'id': 'resume-write', 'type': 'function', 'function': {
                'name': 'write_file', 'arguments': json.dumps({'path': 'resumed.txt', 'content': 'continued'})}}]}
            reason = 'tool_calls'
        else:
            delta, reason = {'content': 'Resumed task complete.'}, 'stop'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        event = {'choices': [{'delta': delta, 'finish_reason': reason}], 'usage': {'total_tokens': 7}}
        self.wfile.write(('data: ' + json.dumps(event) + '\n\ndata: [DONE]\n\n').encode())


class Terminal:
    def __init__(self, args, env):
        self.master, self.slave = pty.openpty()
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack('HHHH', 38, 110, 0, 0))
        self.initial = termios.tcgetattr(self.slave)
        self.child = subprocess.Popen(['node', str(ENTRY), *args], stdin=self.slave, stdout=self.slave, stderr=self.slave, env=env)
        self.log = bytearray()

    def send(self, text):
        start = len(self.log)
        os.write(self.master, text.encode())
        return start

    def expect(self, text, start=0):
        deadline = time.monotonic() + 12
        while text.encode() not in self.log[start:] and time.monotonic() < deadline:
            if select.select([self.master], [], [], .1)[0]:
                self.log.extend(os.read(self.master, 262144))
        assert text.encode() in self.log[start:], (text, bytes(self.log[start:]))

    def close(self):
        if self.child.poll() is None:
            self.child.kill()
            self.child.wait()
        os.close(self.master)
        os.close(self.slave)

    def finish(self):
        self.send('/q\r')
        self.child.wait(timeout=5)
        assert self.child.returncode == 0
        assert termios.tcgetattr(self.slave) == self.initial


server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix='sekai-resume-pty-') as root:
        state = Path(root, 'state')
        sessions = state / 'sessions'
        sessions.mkdir(parents=True)
        for name in ('alpha', 'beta'):
            project = Path(root, name)
            project.mkdir()
            messages = [
                {'role': 'user', 'content': f'{name} original task'},
                {'role': 'assistant', 'content': '', 'tool_calls': [{'id': 'old-read', 'type': 'function', 'function': {
                    'name': 'read_file', 'arguments': '{"path":"old.txt"}'}}]},
                {'role': 'tool', 'tool_call_id': 'old-read', 'content': json.dumps({'text': f'{name} old result'})},
                {'role': 'assistant', 'content': f'{name} previous answer'},
            ]
            saved = {'id': name, 'cwd': str(project), 'title': f'{name} project', 'provider': 'sekai',
                     'model': f'test-{name}', 'messages': messages, 'tokens': 20, 'approval': 'full',
                     'updated': '2026-01-01T12:00:00Z', 'baseUrl': 'http://127.0.0.1:1'}
            (sessions / f'{name}.json').write_text(json.dumps(saved))
        env = {**os.environ, 'TERM': 'xterm-256color', 'SEKAI_HOME': str(state), 'SEKAI_API_KEY': 'resume-test-only'}
        endpoint = ['--base-url', f'http://127.0.0.1:{server.server_port}']
        terminal = Terminal(['resume', '--yolo', *endpoint], env)
        try:
            terminal.expect('Resume session')
            terminal.send('alpha\r')
            terminal.expect('Resumed session alpha')
            start = terminal.send('/status\r')
            terminal.expect('Approvals: full', start)
            start = terminal.send('Continue alpha\r')
            terminal.expect('Resumed task complete.', start)
            assert Path(root, 'alpha', 'resumed.txt').read_text() == 'continued'
            assert requests[0]['model'] == 'test-alpha'
            assert any(m.get('content') == 'alpha original task' for m in requests[0]['messages'])
            assert any('alpha old result' in m.get('content', '') for m in requests[0]['messages'])
            start = terminal.send('/new\r')
            terminal.expect('New session:', start)
            start = terminal.send('/resume latest\r')
            terminal.expect('Resumed session alpha', start)
            start = terminal.send('/resume missing\r')
            terminal.expect('Session not found: missing', start)
            start = terminal.send('/resume\r')
            terminal.expect('Resume session', start)
            terminal.send('\x1b')
            time.sleep(.15)  # Let the terminal distinguish Escape from an Alt-key sequence.
            start = terminal.send('/status\r')
            terminal.expect('Session: alpha', start)
            start = terminal.send('/resume\r')
            terminal.expect('Resume session', start)
            start = terminal.send('beta\r')
            terminal.expect('Resumed session beta', start)
            start = terminal.send('Continue beta\r')
            terminal.expect('Resumed task complete.', start)
            assert Path(root, 'beta', 'resumed.txt').read_text() == 'continued'
            assert requests[2]['model'] == 'test-beta'
            assert any(m.get('content') == 'beta original task' for m in requests[2]['messages'])
            assert not any('alpha original task' in m.get('content', '') for m in requests[2]['messages'])
            assert b'Allow write_file?' not in terminal.log
            terminal.finish()
            for name in ('alpha', 'beta'):
                saved = json.loads((sessions / f'{name}.json').read_text())
                assert saved['tokens'] == 34
                assert any(m.get('content') == f'Continue {name}' for m in saved['messages'])
            if env.get('SEKAI_RESUME_CAPTURE'):
                Path(env['SEKAI_RESUME_CAPTURE']).write_bytes(terminal.log)
        finally:
            terminal.close()

        terminal = Terminal(['resume', 'alpha', '--plain', '--approval', 'ask', *endpoint], env)
        try:
            terminal.expect('approvals: ask')
            start = terminal.send('/status\r')
            terminal.expect('Session: alpha', start)
            terminal.expect('test-alpha', start)
            start = terminal.send('/resume\r')
            terminal.expect('Session number or ID', start)
            start = terminal.send('beta\r')
            terminal.expect('Resumed session beta', start)
            start = terminal.send('/status\r')
            terminal.expect('Approvals: ask', start)
            terminal.finish()
        finally:
            terminal.close()
        print('Resume PTY passed: searchable picker, latest, cancellation, missing ID, context and tool results, project switch, YOLO, plain mode, saved usage, terminal restoration.')
finally:
    server.shutdown()
