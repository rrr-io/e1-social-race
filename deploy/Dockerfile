FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --create-home --uid 10001 pulse
# Explicit copies ensure server-side .env and cookies never enter the image.
COPY --chown=pulse:pulse app.py collectors.py storage.py ./
COPY --chown=pulse:pulse static/ ./static/
COPY --chown=pulse:pulse deploy/healthcheck.py ./deploy/healthcheck.py
RUN mkdir -p /app/data && chown pulse:pulse /app/data
USER pulse
ENV HOST=0.0.0.0 PORT=8000 PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["python", "app.py"]
