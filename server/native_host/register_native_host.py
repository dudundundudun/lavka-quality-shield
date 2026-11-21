#!/usr/bin/env python3
"""
Registers the Lavka Quality Shield Chrome Native Messaging Host in Windows HKCU
(no admin rights required) so the extension can auto-start the :8765 server.
"""
import argparse
import glob
import json
import os
import re
import sys

HOST_NAME = "com.lavka.quality_shield"
EXT_ID_RE = re.compile(r"^[a-p]{32}$")


def detect_extension_ids():
    """Scan local Chromium-based browser Preferences to auto-detect the Extension ID."""
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if not local_app_data:
        return []

    browser_roots = [
        os.path.join(local_app_data, "Google", "Chrome", "User Data"),
        os.path.join(local_app_data, "Microsoft", "Edge", "User Data"),
        os.path.join(local_app_data, "Yandex", "YandexBrowser", "User Data"),
        os.path.join(local_app_data, "BraveSoftware", "Brave-Browser", "User Data"),
    ]

    found = []
    for root in browser_roots:
        if not os.path.isdir(root):
            continue
        for pref_path in glob.glob(os.path.join(root, "*", "Preferences")):
            try:
                with open(pref_path, "r", encoding="utf-8", errors="ignore") as f:
                    data = json.load(f)
            except Exception:
                continue
            settings = data.get("extensions", {}).get("settings", {})
            if not isinstance(settings, dict):
                continue
            for ext_id, info in settings.items():
                if not EXT_ID_RE.match(str(ext_id)):
                    continue
                if not isinstance(info, dict):
                    continue
                manifest = info.get("manifest") or {}
                name = str(manifest.get("name") or "")
                path_str = str(info.get("path") or "")
                if "lavka quality shield" in name.lower() or "lavka-quality-shield" in path_str.lower():
                    if ext_id not in found:
                        found.append(ext_id)
    return found


def register_manifest(ext_ids):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    bat_path = os.path.join(script_dir, "lqs_native_host.bat")
    local_app_data = os.environ.get("LOCALAPPDATA", script_dir)
    manifest_dir = os.path.join(local_app_data, "LavkaQualityShield", "native_host")
    os.makedirs(manifest_dir, exist_ok=True)
    manifest_path = os.path.join(manifest_dir, f"{HOST_NAME}.json")

    manifest_data = {
        "name": HOST_NAME,
        "description": "Lavka Quality Shield Local Server Auto-Launcher",
        "path": bat_path,
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{eid}/" for eid in ext_ids],
    }

    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest_data, f, ensure_ascii=False, indent=2)

    if sys.platform == "win32":
        import winreg

        reg_paths = [
            rf"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}",
            rf"Software\Microsoft\Edge\NativeMessagingHosts\{HOST_NAME}",
            rf"Software\Yandex\YandexBrowser\NativeMessagingHosts\{HOST_NAME}",
            rf"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\{HOST_NAME}",
        ]
        for reg_path in reg_paths:
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, reg_path) as key:
                winreg.SetValueEx(key, "", 0, winreg.REG_SZ, manifest_path)

    return manifest_path


def main():
    parser = argparse.ArgumentParser(description="Register Lavka Quality Shield Native Messaging Host")
    parser.add_argument("--ext-id", default="", help="Chrome Extension ID (32 lowercase letters a-p)")
    parser.add_argument("--non-interactive", action="store_true", help="Do not prompt for input")
    args = parser.parse_args()

    ext_ids = []
    if args.ext_id:
        for part in args.ext_id.split(","):
            cid = part.strip().lower()
            if EXT_ID_RE.match(cid) and cid not in ext_ids:
                ext_ids.append(cid)

    detected = detect_extension_ids()
    for cid in detected:
        if cid not in ext_ids:
            ext_ids.append(cid)

    if not args.non_interactive:
        if ext_ids:
            print(f"[LQS] Автоматически найден ID расширения: {', '.join(ext_ids)}")
            extra = input("[LQS] Нажмите Enter чтобы подтвердить (или вставьте другой ID из chrome://extensions): ").strip().lower()
            if extra:
                if EXT_ID_RE.match(extra):
                    if extra not in ext_ids:
                        ext_ids.insert(0, extra)
                else:
                    print("[WARN] Введённый ID не похож на ID расширения Chrome (32 латинские буквы a-p), использую найденный.")
        else:
            print("[LQS] Не удалось автоматически найти ID расширения в профиле Chrome.")
            print("      Откройте chrome://extensions -> найдите Lavka Quality Shield -> скопируйте ID.")
            manual = input("[LQS] Вставьте ID расширения (или Enter, чтобы пропустить): ").strip().lower()
            if EXT_ID_RE.match(manual):
                ext_ids.append(manual)

    if not ext_ids:
        print("[WARN] ID расширения не указан — регистрация Native Messaging пропущена.")
        sys.exit(2)

    manifest_path = register_manifest(ext_ids)
    print(f"[LQS] Native Messaging Host зарегистрирован: {manifest_path}")
    print(f"[LQS] Разрешённые ID расширений: {', '.join(ext_ids)}")


if __name__ == "__main__":
    main()
