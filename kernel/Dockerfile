# Поверх чего собираемся — параметр, и это весь механизм наследования.
#
# Родитель по умолчанию — python-slim, то есть ровно прежняя сборка. Но им
# может быть и готовый colloq-образ (`--build-arg PARENT=colloq-kernel:base-gpu`),
# и тогда тот же самый файл делает не базу, а тонкий слой поверх неё: torch с
# CUDA остаётся в родителе и не ставится заново.
ARG PARENT=python:3.11-slim-bookworm
FROM ${PARENT}

# Родитель может быть нашим собственным образом, а в нём последним стоит
# `USER runner` — от него ни apt, ни pip не пройдут. На python-slim эта строка
# не меняет ничего: там и так root.
USER root

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    MPLBACKEND=Agg

# Оба шага ниже повторяются на каждом слое цепочки, и это дёшево: на готовом
# родителе curl уже стоит (apt-get тратит секунды на индексы и отвечает
# «already the newest version»), а pip на каждую строку базы отвечает
# «Requirement already satisfied» и ничего не качает. Минуты стоит только то,
# чего в родителе нет, — ради этого наследование и заведено.
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
#
# Идемпотентно: на втором слое цепочки runner уже заведён родителем, а второй
# `useradd` падает «already exists» и роняет сборку целиком.
RUN if ! id -u runner >/dev/null 2>&1; then useradd --create-home --uid 1000 runner; fi \
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
