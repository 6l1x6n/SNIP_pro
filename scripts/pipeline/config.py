"""Минимальный аналог legacy app.config.Settings: переменные окружения + корневой .env.

Нужен только оффлайн-сборщику индекса (build_index.py) — в рантайме продакшена не участвует.
"""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _load_env_file() -> None:
    for candidate in (ROOT / ".env",):
        if not candidate.exists():
            continue
        for line in candidate.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


_load_env_file()


class _Settings:
    """Доступ через атрибуты, как у pydantic-settings: settings.cohere_api_key и т.п."""

    def __getattr__(self, name: str):
        return os.environ.get(name.upper()) or None


settings = _Settings()
