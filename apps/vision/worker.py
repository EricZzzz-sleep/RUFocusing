"""Loopback-only API for the Phase 1 session and vision pipeline."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import threading

from apps.vision.camera import Camera
from core.session import SessionController

ROOT = Path(__file__).resolve().parents[2]


def make_handler(controller, frontend_port=5173):
    allowed_origins = {f'http://127.0.0.1:{frontend_port}', f'http://localhost:{frontend_port}'}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def respond(self, status, data):
            body = json.dumps(data, allow_nan=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def allowed(self):
            host = self.headers.get('Host', '').split(':')[0]
            origin = self.headers.get('Origin')
            if host not in ('127.0.0.1', 'localhost') or (origin and origin not in allowed_origins):
                self.respond(403, {'error': 'Only the local dashboard can access this API.'})
                return False
            return True

        def do_GET(self):
            if not self.allowed():
                return
            if self.path == '/api/health':
                self.respond(200, {'ok': True})
            elif self.path == '/api/state':
                self.respond(200, controller.snapshot())
            else:
                self.respond(404, {'error': 'Not found.'})

        def do_POST(self):
            if not self.allowed():
                return
            if self.headers.get('X-RUFocusing') != '1' or self.headers.get_content_type() != 'application/json':
                self.respond(403, {'error': 'Use the local dashboard to control sessions.'})
                return
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 4096:
                    raise ValueError('Invalid request size.')
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict):
                    raise ValueError('Expected a JSON object.')
                finished = None
                if self.path == '/api/sessions/start':
                    controller.start(data.get('task'), data.get('mode'), data.get('camera', False))
                elif self.path == '/api/sessions/pause':
                    controller.pause()
                elif self.path == '/api/sessions/resume':
                    controller.resume()
                elif self.path == '/api/sessions/end':
                    finished = controller.finish()
                else:
                    self.respond(404, {'error': 'Not found.'})
                    return
                self.respond(200, {**controller.snapshot(), 'finished': finished})
            except (ValueError, TypeError) as error:
                self.respond(400, {'error': str(error)})
            except Exception:
                self.respond(500, {'error': 'The session could not be saved. Check the terminal and local database access.'})
                import traceback
                traceback.print_exc()

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=18765)
    parser.add_argument('--frontend-port', type=int, default=5173)
    parser.add_argument('--database', default=os.environ.get('RUFOCUSING_DB', str(ROOT / '.data/sessions.sqlite3')))
    args = parser.parse_args()
    controller = SessionController(args.database, Camera())
    server = ThreadingHTTPServer(('127.0.0.1', args.port), make_handler(controller, args.frontend_port))
    server.daemon_threads = True
    def stop(_signal, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    controller.start_ticker()
    print(f'Session API ready at http://127.0.0.1:{args.port}', flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        controller.close()


if __name__ == '__main__':
    main()
