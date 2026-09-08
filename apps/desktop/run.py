"""Start both local processes, wait for readiness, and open the dashboard."""
import argparse
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parents[2]


def wait_ready(url, child, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if child.poll() is not None:
            raise RuntimeError('A development server exited. See its output above.')
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            pass
        time.sleep(0.2)
    raise RuntimeError(f'Timed out waiting for {url}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=5173)
    parser.add_argument('--api-port', type=int, default=18765)
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args()
    if args.port == args.api_port:
        parser.error('The frontend and API need different ports.')
    for port in (args.port, args.api_port):
        if not 1024 <= port <= 65535:
            parser.error('Choose ports between 1024 and 65535.')
        with socket.socket() as sock:
            try:
                sock.bind(('127.0.0.1', port))
            except OSError:
                parser.error(f'Port {port} is already in use. Stop the previous server or set PORT/API_PORT when running make.')
    children = []
    def stop(_signal, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        backend = subprocess.Popen([sys.executable, '-m', 'apps.vision.worker', '--port', str(args.api_port), '--frontend-port', str(args.port)], cwd=ROOT, start_new_session=True)
        children.append(backend)
        wait_ready(f'http://127.0.0.1:{args.api_port}/api/health', backend)
        env = dict(os.environ, RUFOCUSING_API_PORT=str(args.api_port))
        frontend = subprocess.Popen(['npm', '--prefix', 'apps/desktop', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', str(args.port), '--strictPort'], cwd=ROOT, env=env, start_new_session=True)
        children.append(frontend)
        url = f'http://127.0.0.1:{args.port}'
        wait_ready(url, frontend)
        print(f'\nRUFocusing is ready: {url}\nPress Ctrl+C to stop both servers.\n', flush=True)
        if not args.no_open and not webbrowser.open(url):
            print('Open the URL above in your browser.', flush=True)
        while all(child.poll() is None for child in children):
            time.sleep(0.3)
        raise RuntimeError('A development server stopped unexpectedly.')
    except KeyboardInterrupt:
        print('\nStopping RUFocusing…', flush=True)
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1
    finally:
        for child in reversed(children):
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
        for child in reversed(children):
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
    return 0


if __name__ == '__main__':
    sys.exit(main())
