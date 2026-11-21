#!/usr/bin/env python3
"""
Lavka Quality Shield — Chrome Native Messaging Host
Allows the Chrome extension to automatically start (or check) the local FastAPI
server on 127.0.0.1:8765 silently in the background on Windows.
"""
import json
import os
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request

HEALTH_URL = "http://127.0.0.1:8765/api/health"


def read_message():
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len or len(raw_len) < 4:
        return None
    msg_len = struct.unpack("<I", raw_len)[0]
    if msg_len == 0 or msg_len > 1024 * 1024:
        return None
    data = sys.stdin.buffer.read(msg_len)
    if not data:
        return None
    return json.loads(data.decode("utf-8"))


def send_message(payload):
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def is_server_running(timeout=1.0):
    try:
        req = urllib.request.Request(HEALTH_URL, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False


def find_server_dir():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    parent = os.path.dirname(script_dir)
    if os.path.isfile(os.path.join(parent, "server.py")):
        return parent
    return script_dir


def find_pythonw():
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if local_app_data:
        venv_scripts = os.path.join(local_app_data, "LavkaQualityShield", "venv", "Scripts")
        for exe in ("pythonw.exe", "python.exe"):
            candidate = os.path.join(venv_scripts, exe)
            if os.path.isfile(candidate):
                return candidate
    if sys.executable:
        pyw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
        if os.path.isfile(pyw):
            return pyw
        return sys.executable
    return "pythonw.exe"


def start_local_server(wait_seconds=10.0):
    if is_server_running(timeout=1.0):
        return {"ok": True, "running": True, "alreadyRunning": True, "started": False}

    server_dir = find_server_dir()
    server_py = os.path.join(server_dir, "server.py")
    if not os.path.isfile(server_py):
        return {
            "ok": False,
            "running": False,
            "error": f"Не найден файл server.py в {server_dir}"
        }

    python_exe = find_pythonw()
    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"

    creationflags = 0
    if sys.platform == "win32":
        creationflags = (
            getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
            | getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
        )

    try:
        subprocess.Popen(
            [python_exe, "-B", server_py],
            cwd=server_dir,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            creationflags=creationflags,
        )
    except Exception as exc:
        return {
            "ok": False,
            "running": False,
            "error": f"Не удалось запустить процесс сервера: {exc}"
        }

    deadline = time.monotonic() + wait_seconds
    while time.monotonic() < deadline:
        time.sleep(0.35)
        if is_server_running(timeout=0.8):
            return {"ok": True, "running": True, "alreadyRunning": False, "started": True}

    return {
        "ok": False,
        "running": False,
        "error": "Процесс запущен, но сервер :8765 не ответил за 10 сек. Проверьте зависимости через start_server.bat."
    }


def main():
    msg = read_message()
    if not isinstance(msg, dict):
        send_message({"ok": False, "error": "Invalid message"})
        return

    action = str(msg.get("action") or "ping").strip().lower()
    if action == "ping":
        running = is_server_running(timeout=1.0)
        send_message({"ok": True, "running": running})
        return

    if action == "start_server":
        send_message(start_local_server(wait_seconds=10.0))
        return

    send_message({"ok": False, "error": f"Unknown action: {action}"})


if __name__ == "__main__":
    main()
