FROM python:3.11-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MPLBACKEND=Agg

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Окружение семинара — слой поверх базы, а не вместо неё.
#
# Два слоя, а не один, ради кеша: база одинакова у всех окружений, поэтому
# docker переиспользует её, и «завести окружение» стоит только тех пакетов,
# которых в базе нет. Один общий слой пересобирался бы целиком на каждую
# правку списка, а это pandas и scikit-learn заново.
#
# Копируется ровно выбранный файл, а не вся папка: иначе правка чужого
# окружения сбрасывала бы кеш этому.
ARG KERNEL_ENV=base
COPY environments/${KERNEL_ENV}.txt /tmp/environment.txt
RUN pip install --no-cache-dir -r /tmp/environment.txt

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
