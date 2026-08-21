FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

WORKDIR /app

# System deps for pdf + ocr (pytesseract) + pg
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libpq-dev curl \
    tesseract-ocr tesseract-ocr-rus tesseract-ocr-kaz \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY . .
# Ensure storage exists
RUN mkdir -p /app/storage/pdfs

# ONNX-эмбеддинги вместо torch (512MB free-tier)
ENV EMBEDDING_PROVIDER=fastembed \
    HF_HUB_DISABLE_TELEMETRY=1 \
    OMP_NUM_THREADS=2

EXPOSE 8001

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "2"]
