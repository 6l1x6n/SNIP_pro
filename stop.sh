#!/bin/bash
# alias для STOP.command
ROOT="$(cd "$(dirname "$0")" && pwd)"
pkill -f "vite --host 0.0.0.0 --port 5173" 2>/dev/null || true
pkill -f "uvicorn app.main:app" 2>/dev/null || true
echo "SNIP.pro stopped (postgres/ollama kept running)"
ps aux | grep -E "vite|uvicorn" | grep -v grep || echo "no vite/uvicorn running"
