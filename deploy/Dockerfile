FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
# Instagram/TikTok extractors break often. A new YTDLP_REFRESH value (the deploy passes the
# date) invalidates this layer so each day's first deploy installs the latest yt-dlp.
ARG YTDLP_REFRESH=0
RUN echo "yt-dlp refresh: ${YTDLP_REFRESH}" && pip install --no-cache-dir --upgrade -r requirements.txt && useradd --create-home --uid 10001 pulse
# Explicit copies ensure server-side .env and cookies never enter the image.
COPY --chown=pulse:pulse app.py collectors.py storage.py race.py ./
COPY --chown=pulse:pulse static/ ./static/
COPY --chown=pulse:pulse deploy/healthcheck.py ./deploy/healthcheck.py
RUN mkdir -p /app/data && chown pulse:pulse /app/data
USER pulse
ENV HOST=0.0.0.0 PORT=8000 PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["python", "app.py"]
