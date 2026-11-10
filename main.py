"""Run the RTSP demo with: python3 main.py."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
from urllib.error import URLError
from urllib.request import urlopen
import venv
import webbrowser


def open_when_ready(process, url):
    for _ in range(40):
        if process.poll() is not None:
            return
        try:
            with urlopen(url + "/api/health", timeout=0.5) as response:
                if json.load(response).get("status") == "ok":
                    webbrowser.open(url)
                    return
        except (URLError, OSError, ValueError):
            pass
        time.sleep(0.25)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        parser.error("Python 3.11 or newer is required")
    if not 1 <= args.port <= 65535:
        parser.error("Port must be between 1 and 65535")

    root = Path(__file__).resolve().parent
    environment = root / ".venv"
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not python.exists():
        print("Creating .venv ...", flush=True)
        venv.EnvBuilder(with_pip=True).create(environment)
    requirements = root / "requirements.txt"
    fingerprint = hashlib.sha256(requirements.read_bytes()).hexdigest()
    marker = environment / ".requirements-sha256"
    if not marker.exists() or marker.read_text().strip() != fingerprint:
        subprocess.run(
            [str(python), "-m", "pip", "install", "-r", str(requirements)],
            check=True, cwd=root,
        )
        marker.write_text(fingerprint + "\n")

    url = f"http://127.0.0.1:{args.port}"
    print(f"Open {url} in Chrome or Edge. Press Ctrl+C to stop.", flush=True)
    process = subprocess.Popen(
        [str(python), "-m", "uvicorn", "server.main:app",
         "--host", "127.0.0.1", "--port", str(args.port)],
        cwd=root,
    )
    if not args.no_browser:
        threading.Thread(target=open_when_ready, args=(process, url), daemon=True).start()
    try:
        return process.wait()
    except KeyboardInterrupt:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as error:
        sys.exit(error.returncode)
