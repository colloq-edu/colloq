FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MPLBACKEND=Agg

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Student code runs as this user; it owns nothing outside /workspace.
RUN useradd --create-home --uid 1000 runner \
 && mkdir -p /workspace \
 && chown runner:runner /workspace
USER runner
WORKDIR /workspace

EXPOSE 8888
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=12 \
  CMD curl -fsS "http://localhost:8888/api/status?token=${JUPYTER_TOKEN}" || exit 1

CMD ["sh", "-c", "exec jupyter server \
  --ServerApp.ip=0.0.0.0 \
  --ServerApp.port=8888 \
  --ServerApp.root_dir=/workspace \
  --ServerApp.allow_remote_access=True \
  --ServerApp.allow_origin='*' \
  --ServerApp.disable_check_xsrf=True \
  --IdentityProvider.token=\"$JUPYTER_TOKEN\" \
  --no-browser"]
