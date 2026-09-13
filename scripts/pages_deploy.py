"""
pages_deploy.py — деплой Pages через Direct Upload API.
Обход: сеть рвёт большие POST через IPv6/undici (SocketError, Broken pipe) —
поэтому каждый файл грузится отдельным `curl -4` с ретраями, затем создаётся deployment.

Использование: python3 scripts/pages_deploy.py <dist_dir> [--project snippy-llm] [--branch master]
"""
import base64
import hashlib
import json
import mimetypes
import subprocess
import sys
import time
import tomllib
import urllib.request
from pathlib import Path

DIST = Path(sys.argv[1] if len(sys.argv) > 1 else "/Users/alikhan/Documents/Projects/SNIP_pro/frontend/dist")
PROJECT = "snippy-llm"
BRANCH = "master"
API = "https://api.cloudflare.com/client/v4"
CONFIG = Path.home() / "Library/Preferences/.wrangler/config/default.toml"


def api(path, method="GET", jwt=None, data=None):
    headers = {"Authorization": f"Bearer {jwt}"} if jwt else {}
    body = json.dumps(data).encode() if data is not None else None
    if body:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(API + path, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read())


def curl(path, jwt, body_file=None, form=None, retries=8):
    cmd = ["curl", "-4", "-sS", "-w", "\\n%{http_code}", "-X", "POST",
           API + path, "-H", f"Authorization: Bearer {jwt}"]
    if body_file:
        cmd += ["-H", "Content-Type: application/json", "--data-binary", f"@{body_file}"]
    elif form:
        for k, v in form:
            cmd += ["-F", f"{k}={v}"]
    last_code = "000"
    attempt = 0
    while attempt < retries * 4:
        r = subprocess.run(cmd, capture_output=True, text=True)
        out = r.stdout.strip()
        code = out.rsplit("\n", 1)[-1] if "\n" in out else out
        body = out.rsplit("\n", 1)[0] if "\n" in out else ""
        if code == "200":
            return json.loads(body) if body else {}
        if code == "403":
            raise JwtExpired(f"403 на {path}")
        wait = min(2 ** attempt * 3, 90)
        print(f"  curl HTTP {code}, пауза {wait}s (попытка {attempt + 1}/{retries}): {r.stderr[:100]}")
        time.sleep(wait)
        attempt += 1
    raise RuntimeError(f"curl HTTP {last_code} исчерпал попытки: {path}")


class JwtExpired(Exception):
    pass


def blake3_hash(path: Path) -> str:
    import blake3
    b64 = base64.b64encode(path.read_bytes()).decode()
    ext = path.suffix.lstrip(".")
    return blake3.blake3((b64 + ext).encode()).hexdigest()[:32]


def main():
    cfg = tomllib.loads(CONFIG.read_text())
    oauth = cfg["oauth_token"]
    acc = api("/accounts", jwt=oauth)["result"][0]["id"]
    print(f"аккаунт: {acc}, проект: {PROJECT}")

    jwt = api(f"/accounts/{acc}/pages/projects/{PROJECT}/upload-token", jwt=oauth)["result"]["jwt"]

    files = []
    for f in sorted(DIST.rglob("*")):
        if f.is_file() and not f.name.startswith("."):
            files.append((f.relative_to(DIST).as_posix(), f))
    print(f"файлов: {len(files)}")

    hashes = {p: blake3_hash(f) for p, f in files}
    missing = set(api("/pages/assets/check-missing", "POST", jwt,
                      {"hashes": list(hashes.values())})["result"])
    todo = [(p, f) for p, f in files if hashes[p] in missing]
    print(f"к загрузке: {len(todo)} ({len(files) - len(todo)} уже на сервере)")

    t0 = time.time()
    jwt_ts = time.time()
    for i, (p, f) in enumerate(todo, 1):
        payload = [{
            "key": hashes[p],
            "value": base64.b64encode(f.read_bytes()).decode(),
            "metadata": {"contentType": mimetypes.guess_type(p)[0] or "application/octet-stream"},
            "base64": True,
        }]
        Path("/tmp/opencode/pages_upl.json").write_text(json.dumps(payload))
        while True:
            if time.time() - jwt_ts > 1500:
                print("  jwt ~истекает — обновляю")
                jwt = api(f"/accounts/{acc}/pages/projects/{PROJECT}/upload-token", jwt=oauth)["result"]["jwt"]
                jwt_ts = time.time()
            try:
                curl("/pages/assets/upload", jwt, body_file="/tmp/opencode/pages_upl.json")
                break
            except JwtExpired:
                print("  jwt истёк (403) — обновляю")
                jwt = api(f"/accounts/{acc}/pages/projects/{PROJECT}/upload-token", jwt=oauth)["result"]["jwt"]
                jwt_ts = time.time()
        if i % 5 == 0 or i == len(todo):
            print(f"  upload {i}/{len(todo)} ({time.time() - t0:.0f}s)")

    Path("/tmp/opencode/pages_hashes.json").write_text(json.dumps({"hashes": list(hashes.values())}))
    curl("/pages/assets/upsert-hashes", jwt, body_file="/tmp/opencode/pages_hashes.json")
    print("хеши зафиксированы")

    manifest = {f"/{p}": hashes[p] for p, f in files}
    dep = curl(f"/accounts/{acc}/pages/projects/{PROJECT}/deployments", oauth,
               form=[("manifest", json.dumps(manifest)), ("branch", BRANCH), ("commit_dirty", "true")])
    d = dep["result"]
    print(f"deployment: {d['id']} ({d['environment']})")

    for _ in range(150):
        time.sleep(5)
        cur = api(f"/accounts/{acc}/pages/projects/{PROJECT}/deployments/{d['id']}", jwt=oauth)["result"]
        if cur.get("latest_stage", {}).get("status") == "success":
            print(f"✅ деплой успешен: {cur['url']}")
            return
        if cur.get("latest_stage", {}).get("status") == "failure":
            sys.exit(f"❌ деплой упал: {[s['name']+':'+s['status'] for s in cur.get('stages', [])]}")
    sys.exit("таймаут ожидания деплоя")


if __name__ == "__main__":
    main()
