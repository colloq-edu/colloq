#!/usr/bin/env bash
#
# Развернуть снятую копию — пара к `make backup`.
#
#   scripts/restore.sh                     самую свежую пару из backups/
#   scripts/restore.sh backups/colloq-20260905-120000.db
#   NAME=demo scripts/restore.sh          самую свежую пару среды demo
#
# Про NAME. Сред бывает несколько — по арендованной машине на каждую, — и копии
# у них разложены по подкаталогам: backups/demo/, backups/hse/. Без NAME
# смотрим в корень backups/: это копии здешнего инстанса, у него имени нет.
# Именно поэтому «самая свежая» ищется в одном каталоге, а не во всех сразу:
# развернуть базу чужого семинара — это чужие тетради, чужие преподаватели и
# ссылки, ведущие в чужие файлы, причём молча.
#
# Зачем это отдельной командой. `make backup` снимает базу и архив с файлами
# семинаров, а обратная дорога до сих пор описывалась словами «положите два
# файла на место». Мест на самом деле три, и одно из них умеет тихо испортить
# базу: рядом с colloq.db в режиме WAL лежат colloq.db-wal и colloq.db-shm, и
# если подложить базу из копии, оставив старый журнал, sqlite накатит на неё
# чужие страницы. Поэтому журнал уезжает вместе с той базой, которую он
# описывает, а не выбрасывается и не остаётся.
#
# Что переживает пересоздание машины и лежит в копии:
#
#   colloq.db          семинары, преподаватели, история версий, настройки оракула
#   workspace/         файлы семинаров — то, что загрузили и создали ячейки
#   data/session-secret  ключ подписи: без него все выданные ссылки и куки мертвы
#   data/setup-token     токен установки — вход в панель, когда ссылка потеряна
#   kernel/environments/*.txt  списки пакетов, в том числе заведённые из панели
#                      прямо на машине: их больше негде взять, а образ по ним
#                      пересобирается одной командой
#
# Чего в копии нет и почему: собранные образы окружений (их дешевле пересобрать
# одной командой, чем возить десятки гигабайт: make env-build NAME=…) и .env
# (он едет на новую машину сам, вместе с репозиторием, — см. scripts/vast.sh).
set -euo pipefail
SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

cd "$(dirname "$0")/.."

# Portable cluster recovery is explicit; a legacy archive is never silently
# overlaid onto a PVC. Validate before stopping writers or moving any data.
if [ "${1:-}" = --archive ]; then
  STATE="${COLLOQ_STATE_DIR:-/var/lib/colloq}"
  if ! python3 scripts/state-lock.py held --state "$STATE"; then
    exec python3 scripts/state-lock.py run --state "$STATE" -- bash "$SCRIPT_PATH" "$@"
  fi
  shift
  ARCHIVE="${1:?archive path required}"; shift
  STATE="${COLLOQ_STATE_DIR:-/var/lib/colloq}"
  RELEASE="${RELEASE:-$STATE/releases/current.json}"
  extra=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --release) RELEASE="${2:?release required}"; shift 2;;
      --replace) extra+=(--replace); shift;;
      --recover) extra+=(--recover); shift;;
      *) echo "Unknown restore argument: $1" >&2; exit 1;;
    esac
  done
  [ -f "$RELEASE" ] || { echo 'Select the matching RELEASE before restoring.' >&2; exit 1; }
  python3 scripts/runtime-backup.py validate --archive "$ARCHIVE" --name "${NAME:-}" --release "$RELEASE"
  mkdir -p "$STATE"
  bash scripts/cluster.sh stop
  python3 scripts/runtime-backup.py restore --root "$STATE" --release "$RELEASE" --archive "$ARCHIVE" --name "${NAME:-}" --defer-finalize "${extra[@]}"
  # A restored older backup may deliberately contain previously retired IDs.
  # Keep the durable marker until those old reservations are removed, with
  # every writer still stopped and the same operation lock held throughout.
  bash scripts/cluster.sh restore-services
  python3 scripts/runtime-backup.py finalize --root "$STATE" --release "$RELEASE" --archive "$ARCHIVE" --name "${NAME:-}"
  # Ownership was set on the validated stage before the durable marker cleared.
  echo 'Restore completed with writers stopped. Run cluster.sh prepare --release, then cluster.sh start.'
  exit 0
fi
if [ -f "${COLLOQ_STATE_DIR:-/var/lib/colloq}/releases/current.json" ]; then
  echo 'Cluster restore requires --archive PORTABLE.tar.gz --release RELEASE.json; legacy overlay is refused.' >&2
  exit 1
fi

RED=$'\033[31m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
say() { printf '%s\n' "$*"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$OFF" >&2; exit 1; }

# Корень СОСТОЯНИЯ — оттуда берутся data/, workspace/ и backups/.
#
# Пара к scripts/backup-local.sh, и по той же причине. Скрипт пришёл сюда из
# мира, где корень был один, и считал data/ с workspace/ от каталога над собой,
# то есть от каталога ПРИЛОЖЕНИЯ. У поставленного через pip colloq это
# site-packages: `colloq restore --legacy` распаковал бы копию занятия рядом с
# кодом — туда, куда не смотрит ни сервер, ни следующий запуск, — и стёр бы её
# первым же `pip install -U`. Адрес состояния приезжает переменной COLLOQ_HOME,
# разбор — в scripts/lib.sh · COLLOQ_STATE_ROOT.
#
# Каталог приложения при этом нужен и дальше: в нём лежат сами скрипты,
# docker-compose.yml и cluster.sh. Поэтому он запоминается, а не теряется.
. ./scripts/lib.sh
APP="$PWD"
STATE="$(cd "$COLLOQ_STATE_ROOT" 2>/dev/null && pwd || true)"
[ -n "$STATE" ] || die "no state directory \"${COLLOQ_STATE_ROOT}\" — check COLLOQ_HOME."
cd "$STATE"

# Каталог копий одной среды. Имя приезжает переменной окружения, как HOST у
# `make host`: так его передаёт Makefile, и так оно не мешает старому вызову с
# путями в аргументах. Проверяем те же знаки, что и vast.sh: имя уходит в путь,
# и «../» увело бы восстановление за пределы backups/.
ENV_NAME="${NAME:-}"
case "$ENV_NAME" in
  '') : ;;
  *[!A-Za-z0-9-]*|-*|*-) die "deployment name \"${ENV_NAME}\" is not valid: letters, digits and a hyphen inside." ;;
esac
BACKUP_DIR="backups${ENV_NAME:+/$ENV_NAME}"

DB=""
FILES=""
for arg in "$@"; do
  case "$arg" in
    *.db) DB="$arg" ;;
    *.tar.gz) FILES="$arg" ;;
    *) die "I do not understand \"${arg}\". Expected backups/colloq-<date>.db and/or backups/colloq-<date>-files.tar.gz" ;;
  esac
done

if [ -z "$DB" ] && [ -z "$FILES" ]; then
  DB="$(ls -1t "$BACKUP_DIR"/colloq-*.db 2>/dev/null | head -1 || true)"
  if [ -z "$DB" ]; then
    # Список сред печатается прямо в отказе: «копий нет» при полном backups/hse
    # — это не отсутствие копии, а не то имя, и выяснять это на пустой машине
    # посреди занятия незачем.
    others="$(ls -1d backups/*/ 2>/dev/null | sed 's#backups/##;s#/##' | tr '\n' ' ' | sed 's/ *$//' || true)"
    # Совет называется командой, которая есть на ЭТОЙ машине: у поставленного
    # пакета Makefile нет, и «make backup» было бы вторым отказом подряд.
    take="colloq backup"; [ "$STATE" = "$APP" ] && take="make backup"
    die "there is not a single backup in $BACKUP_DIR/.
  Take one on a running instance: $take${others:+
  Backups of other deployments live in subdirectories: $others
  Restore a deployment backup: make restore NAME=<name>}"
  fi
fi
# Архив ищется по имени базы, а не по «самому свежему»: пара из базы одного дня
# и файлов другого — это семинар, у которого в тетради есть ссылка на файл,
# которого нет.
if [ -z "$FILES" ] && [ -n "$DB" ] && [ -f "${DB%.db}-files.tar.gz" ]; then
  FILES="${DB%.db}-files.tar.gz"
fi

[ -z "$DB" ] || [ -f "$DB" ] || die "no file $DB"
[ -z "$FILES" ] || [ -f "$FILES" ] || die "no file $FILES"

say "${BOLD}1/3${OFF} checking there is somewhere to restore into"

# Под работающим сервером базу не подменяют. sqlite держит открытым тот файл,
# который открыл: старый inode останется живым до последнего закрытия, семинар
# продолжит писать в файл, которого уже нет на диске, а после перезапуска эта
# работа просто исчезнет. Причём на экране до самого перезапуска всё выглядит
# исправно — поэтому проверка здесь, а не в напутствии внизу.
# Читает .env общий read_env (scripts/lib.sh) — тот же, что у host.sh и
# service.sh: одна копия правила на все скрипты. Подключён он выше, вместе с
# корнем состояния: оттуда же берётся и путь к .env.
PORT="$(read_env PORT)"; PORT="${PORT:-3000}"
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet colloq 2>/dev/null; then
  die "the colloq service is running — stop it first: make service-stop.
  A stopped service is not yet an empty machine: restoring a backup over today's
  work still has to be deliberate, see REPLACE=1 further down."
fi
# Спрашиваем из каталога ПРИЛОЖЕНИЯ: docker-compose.yml лежит там, а мы стоим
# в состоянии. У поставленного пакета compose нет вовсе — вопрос останется без
# ответа, и это верный ответ: контейнером там никто не поднимается.
if (cd "$APP" && docker compose ps --status running --services 2>/dev/null) | grep -qx app; then
  die "app is running in docker — stop it first: make down"
fi
if [ -f .colloq.pid ] && kill -0 "$(cat .colloq.pid 2>/dev/null)" 2>/dev/null; then
  die "a class is running on this machine — first: colloq stop"
fi
if curl -sf -o /dev/null --max-time 3 "http://localhost:$PORT/api/health" 2>/dev/null; then
  die "something answers on localhost:$PORT — that is a second Colloq.
  Stop it (make down · make stop) and try again."
fi

# Поверх непустой машины — только по просьбе.
#
# Разворачивание необратимо ровно наполовину, и это худший из вариантов: база
# откладывается в colloq.db.replaced-<штамп> (о котором потом никто не
# вспомнит), а архив ложится на workspace/ поверх, перезаписывая одноимённые
# файлы без всякой копии. Поэтому «здесь уже что-то есть» — это вопрос, а не
# повод действовать: скрипт зовут и руками («откатить на вчера»), и из
# scripts/vast.sh, где повод бывает случайным.
#
# Спрашиваем, только когда есть у кого: на той стороне ssh терминала нет, на
# stdin висит heredoc — и `read` съел бы остаток скрипта. Без терминала нужен
# REPLACE=1, названный вслух.
if [ -n "$DB" ] && [ -s data/colloq.db ]; then
  if [ "${REPLACE:-}" = 1 ]; then
    say "${DIM}    a database is already here — restoring over it (REPLACE=1)${OFF}"
  elif [ -t 0 ]; then
    say "${RED}There is already a data/colloq.db here${OFF} — classes, teachers, version history."
    say "${DIM}It will be set aside as data/colloq.db.replaced-<stamp>, and the archive will${OFF}"
    say "${DIM}land on workspace/ — same-named files are overwritten with no backup.${OFF}"
    printf '%srestore the backup over it? [y/N] %s' "$BOLD" "$OFF"
    read -r answer
    case "$answer" in y|Y|yes|YES|Yes) : ;; *) die "not restoring." ;; esac
  else
    die "there is already a data/colloq.db here, and no terminal to ask in.
  This is not an empty machine: restoring a backup over it means setting the
  current database aside as data/colloq.db.replaced-<stamp> and unpacking the
  archive on top of workspace/.
  If that is what you want: REPLACE=1 $0 $*"
  fi
fi

mkdir -p data workspace
STAMP="$(date +%Y%m%d-%H%M%S)"

say "${BOLD}2/3${OFF} database"
if [ -n "$DB" ]; then
  # Дешёвая проверка вместо доверия расширению: первые шестнадцать байт файла
  # sqlite — это «SQLite format 3». Восстановить пустой файл, скачавшийся до
  # половины, значит потерять и то, что было.
  head -c 16 "$DB" | LC_ALL=C grep -qa 'SQLite format 3' \
    || die "$DB does not look like an sqlite database — the backup is broken or incomplete."
  if command -v sqlite3 >/dev/null 2>&1; then
    [ "$(sqlite3 "$DB" 'pragma quick_check')" = ok ] \
      || die "$DB does not pass the sqlite check. Take another backup."
  fi
  if [ -f data/colloq.db ]; then
    # Прежняя база уезжает целиком со своим журналом. Не удаляется — «я нажал
    # restore не той копией» должно быть поправимо; и не остаётся на месте —
    # старый -wal, накаченный на новую базу, портит её молча.
    mv data/colloq.db "data/colloq.db.replaced-$STAMP"
    for j in wal shm; do
      if [ -f "data/colloq.db-$j" ]; then
        mv "data/colloq.db-$j" "data/colloq.db.replaced-$STAMP-$j"
      fi
    done
    say "${DIM}    the previous database is set aside as data/colloq.db.replaced-$STAMP${OFF}"
  fi
  cp "$DB" data/colloq.db
  chmod 600 data/colloq.db
  say "    $DB → data/colloq.db"
else
  say "${DIM}    not touching the database — it was not in the arguments${OFF}"
fi

say "${BOLD}3/3${OFF} class files and keys"
if [ -n "$FILES" ]; then
  # Разворачивается поверх, а не вместо: комнаты, которых в копии нет, остаются
  # на месте. Забрать лишнее всегда можно, а вернуть стёртое — нет.
  #
  # -p обязателен: у data/session-secret права 0600, и без сохранения режима
  # ключ подписи стал бы читаемым для всех, кто есть на машине.
  tar -xzpf "$FILES"
  # Куда легли списки окружений — зависит от того, разошлись ли корни: в
  # репозитории это kernel/environments, у поставленного пакета — свой каталог
  # рядом с .env. Ровно так их и клал scripts/backup-local.sh, и называть надо
  # то же место, иначе человек пойдёт искать файлы не туда.
  if [ "$STATE" = "$APP" ]; then lists=kernel/environments; else lists=environments; fi
  say "    $FILES → workspace/, data/, $lists/"
  if [ -f data/session-secret ]; then
    chmod 600 data/session-secret
    say "${DIM}    the signing key is in place — issued links and cookies survive the move${OFF}"
  fi
  if [ -f data/setup-token ]; then
    chmod 600 data/setup-token
  fi
else
  say "${DIM}    no file archive — only the database was restored.${OFF}"
  say "${DIM}    Notebooks and settings are in place, uploaded files are not.${OFF}"
fi

# Хозяин файлов — тот, от кого работает сервер, а не тот, кто восстанавливал.
#
# Под `make up` сервер в контейнере работает от `node` (uid 1000), а копию на
# новой машине разворачивает root: база и папки оставались root:root, и
# контейнер падал по кругу с «unable to open database file». Локально этого не
# видно вовсе — при `make run` сервер и есть тот, кто распаковал.
#
# А на выделенной машине сервер стоит службой и работает от root — там uid 1000
# у базы означал бы ровно обратную ошибку. Поэтому форму спрашиваем, а не
# угадываем: есть юнит — сервер root, нет — сервер в контейнере. И спрашиваем с
# оговоркой: на новой машине копию разворачивают ДО установки службы (иначе
# сервер откроет базу, которую мы собираемся подменить), и юнита там ещё нет —
# поэтому scripts/vast.sh говорит форму прямо, FORM=service.
#
# Что не зависит от формы: workspace/. В него пишет ядро комнаты, а оно всегда
# uid 1000 (kernel/Dockerfile, пользователь runner). Под службой сервер кладёт
# туда же свои файлы от root, поэтому каталогам ставится группа 1000 и бит
# setgid: всё новое внутри достаётся этой группе, а право писать ей даёт
# UMask=0002 из юнита. Без пары «setgid + umask» первая ячейка с open(…,'w')
# в свежей комнате падает PermissionError на зелёном экране.
#
# Тысяча здесь — умолчание, а не истина: группу ядру выдаёт useradd, и в
# окружении поверх чужой базы она может оказаться другой. Точный номер ставит
# scripts/service.sh, спросив его у самого образа; там же это и повторяется
# после каждой установки.
#
# Только когда мы root и только на этих двух каталогах: чужие права здесь не
# трогаются, а на macOS (там uid другой и всё и так своё) шаг пропускается.
FORM="${FORM:-}"
if [ -z "$FORM" ] && [ -f /etc/systemd/system/colloq.service ]; then FORM=service; fi
if [ "$(id -u)" = 0 ] && [ "$(uname -s)" = Linux ]; then
  if [ "$FORM" = service ]; then
    chown -R root:root data
    # Группа, а не владелец. Владельца у файлов внутри workspace/ менять нельзя:
    # то, что распаковалось от uid 1000, ядро писало как хозяин, и став
    # root:1000 с правами 0644 оно стало бы для ядра нечитаемым на запись.
    # Группа же 1000 плюс setgid на каталогах дают обеим сторонам заводить и
    # удалять файлы внутри, не трогая уже лежащие.
    chgrp -R 1000 workspace
    find workspace -type d -exec chmod 2775 {} + 2>/dev/null || true
    say "${DIM}    data/ — root's (the server is a service), workspace/ — group 1000 (the kernel)${OFF}"
  else
    chown -R 1000:1000 data workspace
    say "${DIM}    data/ and workspace/ — uid 1000: that is who the server is in the container${OFF}"
  fi
fi

printf '\n'
say "${BOLD}done${OFF}"
# Куда идти дальше — словом, которое есть у того, кто это читает.
#
# Прежнее напутствие звало `make up / make run / make service-install` и
# `make env-build NAME=…`. У поставленного через pip colloq make нет вовсе
# (в колесо едут приложение и scripts/, Makefile не едет — scripts/pack.mts ·
# SCRIPTS), и обе строки врали ровно тому, кто только что развернул копию на
# новой машине и ищет, чем её запустить. У пакета это `colloq start`: образ
# окружения он собирает сам, первым запуском (cli/src/commands/env.ts · env
# use). Рядом с исходниками — make: там же живёт и цель service-install
# выделенной машины.
if [ "$STATE" = "$APP" ]; then
  say "${DIM}Start a class: make run (make dev for development)${OFF}"
  say "${DIM}On a dedicated machine the class is held by a service: make service-install.${OFF}"
else
  say "${DIM}Start a class: colloq start${OFF}"
fi
say "${DIM}Kernel environments are not restored here —${OFF}"
say "${DIM}the image is built on the next start of a class.${OFF}"
say "${DIM}Pinned competition images must be restored separately with their exact image IDs (see backup/restore docs).${OFF}"
say "${DIM}The Oracle key, RELAY_* and PUBLIC_URL live in .env, not in the backup.${OFF}"
