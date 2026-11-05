FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
# OCR engine for the collab verifier (certificate IDs).
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir -r requirements.txt && useradd --create-home --uid 10001 pulse
COPY --chown=pulse:pulse . .
RUN mkdir -p /app/data && chown pulse:pulse /app/data
USER pulse
ENV HOST=0.0.0.0 PORT=8000 PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["python", "app.py"]
