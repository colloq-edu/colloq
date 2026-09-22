# Проверенное окружение kaggle-base

Лёгкое CPU-окружение Colloq для табличных соревнований. Не официальный Docker-образ Kaggle.

- Рецепт: `../environments/kaggle-base.txt` (точные версии основных пакетов, родитель base).
- `kaggle-base.inventory.json`: полный установленный состав, включая bootstrap-пакеты.
- `kaggle-base.txt`: результат pip freeze.
- `kaggle-base.image.json`: локальный образ, архитектура и image ID после проверки.
- `kaggle-base.smoke.json`: обучение трёх бустингов и проверки остальных библиотек без сети.
- `kaggle-base.submission-check.json`: реальная посылка CatBoost через API соревнования ПВЗ; результат исключён из зачёта.

Проверка образа:

```sh
docker run --rm --network none --read-only --tmpfs /tmp:rw,size=512m --user 1000:1000 --cpus 2 --memory 4g -e HOME=/tmp -e MPLCONFIGDIR=/tmp/mpl -e NUMBA_CACHE_DIR=/tmp/numba -v "$PWD/scripts/check-kaggle-base.py:/check.py:ro" colloq-kernel:kaggle-base python /check.py
```

Снимок относится к проверенной локальной ARM64-сборке. На другой платформе образ нужно собрать и проверить отдельно; список wheel-файлов не переносится между ABI и архитектурами автоматически.
