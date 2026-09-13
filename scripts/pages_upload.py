"""
pages_upload.py — надёжный Direct Upload в Cloudflare Pages минус капризы сети.

Wrangler грузит ассеты пачками одним большим multipart — на нестабильном канале
он рвётся (EPIPE) и падает весь деплой. Здесь: по одному файлу за запрос,
ретраи ×7 с паузами, точечная диагностика какой именно файл не проходит.
Токен берём из конфига wrangler (~/Library/Preferences/.wranlger/config), при
истечении — авто-refresh.

Использование: python3 pages_upload.py <dist_dir> <project> <branch>
"""
import base64
import hashlib
import json
import sys
import time
from pathlib import Path

import httpx

CF_API = "https://api.cloudflare.com/client/v4"
CONFIG = Path.home() / "Library/Preferences/.wrangler/config/default.toml"


def load_token():
    """OAuth-токен из конфига wrangler + refresh при необходимости."""
    text = CONFIG.read_text()
    tok = None
    refresh = None
    expire = 0
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("oauth_token"):
            tok = line.split("=", 1)[1].strip().strip('"')
        elif line.startswith("refresh_token"):
            refresh = line.split("=", 1)[1].strip().strip('"')
        elif line.startswith("expiration_time"):
            import re
            m = re.search(r'"([^"]+)"', line)
            if m:
                from datetime import datetime
                try:
                    expire = datetime.fromisoformat(m.group(1).replace("Z", "+00:00")).timestamp()
                except Exception:
                    pass
    return tok, refresh, expire


def ensure_fresh_token():
    """Проактивно обновляем токен, если до истечения < 5 минут."""
    global HEADERS, TOKEN_STATE
    tok, refresh, expire = load_token()
    TOKEN_STATE = {"refresh": refresh}
    import time as _t
    if expire and _t.time() > expire - 300 and refresh:
        print("… OAuth-токен скоро истечёт, обновляю заранее")
        refresh_tokens(refresh)
    else:
        HEADERS = {"Authorization": f"Bearer {tok}"}


def refresh_tokens(refresh_token):
    global HEADERS
    print("… OAuth-токен истёк, обновляю")
    r = httpx.post(
        "https://dash.cloudflare.com/oauth2/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": "54d11594-84e4-41aa-b438-e81b8fa78ee7",  # публичный client_id wrangler
        },
        timeout=30,
    )
    r.raise_for_status()
    d = r.json()
    # пропишем новый токен обратно в конфиг, чтобы wrangler тоже его видел
    new_line = f'oauth_token = "{d["access_token"]}"'
    lines = []
    for line in CONFIG.read_text().splitlines():
        lines.append(new_line if line.strip().startswith("oauth_token") else line)
    CONFIG.write_text("\n".join(lines) + "\n")
    HEADERS = {"Authorization": f"Bearer {d['access_token']}"}


HEADERS = {}
TOKEN_STATE = {}


def api(method, url, **kw):
    """Запрос к CF API с одним автоматическим рефрешем токена."""
    for attempt in range(2):
        r = httpx.request(method, url, headers=HEADERS, timeout=60, **kw)
        if r.status_code == 401 and attempt == 0 and TOKEN_STATE.get("refresh"):
            refresh_tokens(TOKEN_STATE["refresh"])
            continue
        return r
    return r


def file_key(data: bytes) -> str:
    """Формат ключей wrangler: base64(sha256-hex(content))."""
    return base64.b64encode(hashlib.sha256(data).hexdigest().encode()).decode()


def main():
    global TOKEN_STATE
    dist, project, branch = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    account_id = sys.argv[4]

    ensure_fresh_token()
    # 1. Собираем манифест файлов
    manifest = {}
    contents = {}
    for p in sorted(dist.rglob("*")):
        if p.is_file() and not p.name.startswith("."):
            data = p.read_bytes()
            key = file_key(data)
            manifest[key] = "/" + str(p.relative_to(dist)).replace("\\", "/")
            contents[key] = data
    print(f"файлов в dist: {len(manifest)}")

    # 1b. Краткоживущий JWT для ассет-эндпоинтов (как делает wrangler — GET!)
    r = api("GET", f"{CF_API}/accounts/{account_id}/pages/projects/{project}/upload-token")
    r.raise_for_status()
    jwt = r.json()["result"]
    ASSET_HEADERS = {"Authorization": f"Bearer {jwt}"}

    # 2. Какие отсутствуют на сервере
    for attempt in range(5):
        r = httpx.post(f"{CF_API}/pages/assets/check-missing", headers=ASSET_HEADERS,
                       json={"hashes": list(manifest.keys())}, timeout=60)
        if r.status_code == 200:
            break
        print(f"check-missing попытка {attempt+1}: HTTP {r.status_code}, повтор через 15с")
        time.sleep(15)
    r.raise_for_status()
    missing = set(r.json()["result"])
    print(f"требуют загрузки: {len(missing)} из {len(manifest)}")

    # 3. Загружаем по одному файлу, ретраи ×7
    failed = []
    for i, key in enumerate(sorted(missing), 1):
        ok = False
        for attempt in range(7):
            try:
                files = {key: ("file", contents[key])}
                r = httpx.post(f"{CF_API}/pages/assets/upload",
                               headers=ASSET_HEADERS, files=files, timeout=120)
                if r.status_code == 200:
                    ok = True
                    break
                print(f"  [{i}/{len(missing)}] HTTP {r.status_code}, повтор ({attempt+1}/7)")
            except Exception as e:
                print(f"  [{i}/{len(missing)}] сеть: {str(e)[:70]} повтор ({attempt+1}/7)")
            time.sleep(min(10 * (attempt + 1), 60))
        size_kb = len(contents[key]) // 1024
        print(f"[{i}/{len(missing)}] {'✅' if ok else '❌'} {manifest[key]} ({size_kb} КБ)")
        if not ok:
            failed.append(manifest[key])
    if failed:
        sys.exit(f"Не удалось загрузить: {failed}")

    # 4. Создаём деплой
    payload = {"manifest": manifest, "branch": branch, "commit_id": None}
    for attempt in range(5):
        r = api("POST", f"{CF_API}/accounts/{account_id}/pages/projects/{project}/deployments",
                json=payload)
        if r.status_code == 200:
            d = r.json()["result"]
            print(f"🚀 Деплой создан: {d.get('url')}")
            return
        print(f"create-deployment HTTP {r.status_code}: {r.text[:200]}, повтор через 15с")
        time.sleep(15)
    sys.exit("Не удалось создать деплой")


if __name__ == "__main__":
    main()
