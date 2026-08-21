FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1

WORKDIR /app

# System deps for pdf + ocr (optional) + pg
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libpq-dev curl \
    libgl1 libglib2.0-0 \
    tesseract-ocr tesseract-ocr-rus tesseract-ocr-kaz \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY . .
# Ensure storage exists
RUN mkdir -p /app/storage/pdfs

EXPOSE 8001

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "2"]
