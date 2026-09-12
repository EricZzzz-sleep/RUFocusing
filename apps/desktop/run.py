"""Start both local processes, wait for readiness, and open the dashboard."""
import argparse
import hashlib
import json
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


def already_running(port, api_port):
    """Only reuse a healthy frontend/API pair belonging to this checkout."""
    expected = {
        'ok': True,
        'app': 'RUFocusing',
        'api_version': 4,
        'project': hashlib.sha256(str(ROOT).encode()).hexdigest(),
        'frontend_port': port,
    }
    for service_port in (api_port, port):
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{service_port}/api/health', timeout=1) as response:
                if response.status != 200 or json.loads(response.read(4096)) != expected:
                    return False
        except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError):
            return False
    return True


def open_dashboard(url):
    try:
        if webbrowser.open(url):
            return
    except (webbrowser.Error, OSError):
        pass
    print(f'Could not open a browser automatically. Open {url} in your browser.', flush=True)


def port_available(port):
    with socket.socket() as sock:
        # Match the servers' reuse behavior: recently closed connections must
        # not make an immediate restart look like another running server.
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(('127.0.0.1', port))
        except OSError:
            return False
    return True


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


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=5173)
    parser.add_argument('--api-port', type=int, default=18765)
    parser.add_argument('--no-open', action='store_true')
    args = parser.parse_args(argv)
    if args.port == args.api_port:
        parser.error('The frontend and API need different ports.')
    for port in (args.port, args.api_port):
        if not 1024 <= port <= 65535:
            parser.error('Choose ports between 1024 and 65535.')
    url = f'http://127.0.0.1:{args.port}'
    if already_running(args.port, args.api_port):
        print(f'RUFocusing is already running: {url}\nThe existing session and servers are unchanged.', flush=True)
        if not args.no_open:
            open_dashboard(url)
        return 0
    for port in (args.port, args.api_port):
        if not port_available(port):
            parser.error(f'Port {port} is in use, but a healthy RUFocusing frontend/API pair could not be found. Stop the previous server with Ctrl+C in its terminal, or run make run PORT=5174 API_PORT=18766.')
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
        wait_ready(url, frontend)
        print(f'\nRUFocusing is ready: {url}\nPress Ctrl+C to stop both servers.\n', flush=True)
        if not args.no_open:
            open_dashboard(url)
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
