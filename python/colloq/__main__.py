"""Шим: найти Node, при первом запуске поставить node_modules, отдать управление CLI.

Больше здесь не происходит ничего, и это намеренно. Логика занятия — сборка,
ядра, порты, туннель, остановка — живёт в CLI (_app/cli/colloq.mjs, собран из
cli/src) и в супервизоре занятия, которым пользуется и `npm run dev` в
репозитории. Второй, питонский, слой правил означал бы две программы на одно
дело, и чинить пришлось бы обе.

Что шим делает по шагам:

  1. ищет node — сначала в PATH, потом там, где его кладут установщики;
     проверяет, что версия не ниже 22 (better-sqlite3 13 заявляет node >=22, а
     на 18 сервер и вовсе падает на ходу, а не при старте);
  2. если рядом с приложением нет node_modules — ставит их один раз npm-ом и
     говорит об этом вслух: молчаливая минута на первом запуске читается как
     «зависло»;
  3. выставляет COLLOQ_APP_DIR (где лежит приложение) и COLLOQ_CWD (откуда
     позвали);
  4. заменяет собой процесс Node через execve — чтобы Ctrl+C уходил прямо в
     CLI, а код возврата приходил прямо от него. Прослойка-надзиратель здесь
     сломала бы и то, и другое: Ctrl+C на паре означает «сохрани и останови
     занятие», и он должен дойти до того, кто умеет это сделать.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Iterator, NoReturn, Optional, Tuple

#: Приложение лежит внутри пакета: так его кладёт в колесо scripts/pack.mts.
APP = Path(__file__).resolve().parent / "_app"
ENTRY = APP / "cli" / "colloq.mjs"
MARK = APP / ".colloq-dist.json"
STAMP = APP / ".node-modules.json"
LOCK = APP / ".node-modules.lock"

#: Ниже 22 не бывает: better-sqlite3 13 заявляет node >=22 (server/package.json),
#: и это же версия образа в Dockerfile. С 13-й он на N-API: один готовый бинарь
#: на все версии Node выше, и пересборка под «свой» Node преподавателю не грозит.
MIN_NODE = 22
#: Сколько ждать чужую установку, прежде чем считать замок брошенным.
LOCK_WAIT_SEC = 900
#: Слова, ради которых незачем ставить окружение: они только рассказывают.
#: `colloq --help` сразу после установки — самое частое первое действие, и
#: минута npm в ответ на просьбу показать список команд была бы издевательством.
#: Сам CLI собран без единой внешней зависимости (это стережёт scripts/pack.mts),
#: так что ответить ему есть чем и без node_modules.
#:
#: Голый `colloq` в этот список НЕ входит, хотя тоже только рассказывает. Он —
#: первое, что набирают после `pip install colloq`, и это лучший момент для
#: разовой минуты: занятие начинается словом `colloq start`, и вот тогда ждать
#: уже нечего — до пары остаются минуты, а не вечер.
TELLING = frozenset(["--help", "-h", "help", "--version", "-V"])


def fail(*lines: str) -> NoReturn:
    """Отказ словами, без трассировки: её здесь некому читать."""
    for line in lines:
        print(line, file=sys.stderr, flush=True)
    raise SystemExit(3)


def _version_key(path: Path) -> Tuple[int, ...]:
    """Ключ сортировки для каталогов вида node-20.11.1: числами, а не строкой."""
    numbers = re.findall(r"\d+", str(path))
    return tuple(int(number) for number in numbers[-3:]) or (0,)


def _candidates() -> Iterator[str]:
    """Где бывает node, в порядке убывания доверия.

    PATH — первым: если преподаватель поставил себе Node сам, он ожидает именно
    свой. Дальше обычные места установщиков: тот же Homebrew кладёт node в
    /opt/homebrew/bin, которого нет в PATH у процессов, запущенных не из
    оболочки, — а pip-скрипт вполне может быть запущен из чего угодно.
    Менеджеры версий (nvm, fnm, volta, asdf) перебираются последними и сверху
    вниз по версии: у них node в PATH появляется только после `source`, и без
    этого списка `colloq` в свежем терминале говорил бы «поставьте Node»
    человеку, у которого он стоит.
    """
    found = shutil.which("node")
    if found:
        yield found
    for fixed in (
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
        "/opt/local/bin/node",
        "/snap/bin/node",
    ):
        yield fixed
    home = Path.home()
    for pattern in (
        ".nvm/versions/node/*/bin/node",
        ".local/share/fnm/node-versions/*/installation/bin/node",
        ".fnm/node-versions/*/installation/bin/node",
        ".volta/tools/image/node/*/bin/node",
        ".asdf/installs/nodejs/*/bin/node",
    ):
        for path in sorted(home.glob(pattern), key=_version_key, reverse=True):
            yield str(path)


def _node_version(node: str) -> Optional[Tuple[int, int, int]]:
    try:
        done = subprocess.run(
            [node, "--version"], capture_output=True, text=True, timeout=15
        )
    except (OSError, subprocess.SubprocessError):
        return None
    match = re.match(r"v(\d+)\.(\d+)\.(\d+)", (done.stdout or "").strip())
    if done.returncode != 0 or not match:
        return None
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)))


def find_node() -> str:
    """Первый работающий node не ниже MIN_NODE.

    Отдельно разбирается случай «node есть, но старый»: сказать такому человеку
    «Node не найден» — значит отправить его ставить второй раз то, что у него
    стоит, и удивляться, почему не помогает.
    """
    seen = set()
    old: Optional[str] = None
    for candidate in _candidates():
        if candidate in seen:
            continue
        seen.add(candidate)
        if not os.path.isfile(candidate) or not os.access(candidate, os.X_OK):
            continue
        version = _node_version(candidate)
        if version is None:
            continue
        if version[0] >= MIN_NODE:
            return candidate
        if old is None:
            old = "%s (v%d.%d.%d)" % (candidate, version[0], version[1], version[2])
    if old:
        fail(
            "Node is too old: " + old,
            "Colloq needs Node %d or newer." % MIN_NODE,
            "macOS: brew install node · Debian/Ubuntu: see https://nodejs.org/en/download",
        )
    fail(
        "Node.js not found — Colloq cannot start without it.",
        "Node %d or newer is required." % MIN_NODE,
        "macOS: brew install node · Debian/Ubuntu: apt install nodejs (or https://nodejs.org/en/download)",
        "If Node is installed somewhere unusual, add it to PATH.",
    )


def find_npm(node: str) -> Optional[str]:
    """npm рядом с node или в PATH.

    Рядом — первым: у менеджеров версий (nvm, fnm) в PATH может лежать npm от
    совсем другой версии Node, и ставить нативные модули той версией, которой
    их потом не запускать, — это тихая поломка better-sqlite3 на ровном месте.
    """
    names = ["npm.cmd", "npm"] if os.name == "nt" else ["npm"]
    for name in names:
        near = Path(node).parent / name
        if near.is_file():
            return str(near)
    for name in names:
        found = shutil.which(name)
        if found:
            return found
    return None


def _wanted() -> dict:
    """Чего ждут node_modules: версия приложения и список зависимостей.

    Сравнивается целиком, а не «каталог существует»: после обновления колеса
    приложение новое, а node_modules рядом — от прошлой версии, и они молча
    подходят по именам, но не по содержимому.
    """
    data = json.loads((APP / "package.json").read_text(encoding="utf-8"))
    return {
        "version": data.get("version"),
        "dependencies": data.get("dependencies", {}),
    }


def _ready(wanted: dict) -> bool:
    if not (APP / "node_modules").is_dir():
        return False
    try:
        return json.loads(STAMP.read_text(encoding="utf-8")) == wanted
    except (OSError, ValueError):
        return False


def _install(npm: str, wanted: dict) -> None:
    # flush у каждой строки — не суеверие. Дальше идёт чужой процесс (npm), а
    # в конце os.execve, который выбрасывает буфер стандартного вывода не
    # напечатав: при выводе в файл или в конвейер обе эти строки пропадали
    # целиком, и разовая минута ожидания выглядела зависанием без объяснений.
    print("Installing Colloq's Node environment — once, a minute or two.", flush=True)
    print("Directory: %s" % APP, flush=True)
    done = subprocess.run(
        [npm, "install", "--omit=dev", "--no-audit", "--no-fund"],
        cwd=str(APP),
    )
    if done.returncode != 0:
        fail(
            "",
            "Could not install the Node environment (npm exited with %d)." % done.returncode,
            "Run it by hand: cd %s && npm install --omit=dev" % APP,
        )
    STAMP.write_text(json.dumps(wanted, ensure_ascii=False, indent=2), encoding="utf-8")
    print("Environment ready.\n", flush=True)


def ensure_modules(node: str) -> None:
    """node_modules рядом с приложением — ставятся один раз, на этой машине.

    Почему их нет в колесе: better-sqlite3 и @resvg/resvg-js — нативные, и
    колесо с ними перестало бы быть одним на всех (своё на macOS arm64, своё на
    Linux x86_64, своё на каждую версию Node ABI). Цена такого решения — одна
    минута на первом запуске, и она названа вслух, а не проведена молча.
    """
    wanted = _wanted()
    if _ready(wanted):
        return
    npm = find_npm(node)
    if not npm:
        fail(
            "No npm next to Node, and the server environment cannot be installed without it.",
            "npm normally ships with Node: check `npm --version`.",
            "What should happen: cd %s && npm install --omit=dev" % APP,
        )
    if not os.access(str(APP), os.W_OK):
        fail(
            "The application directory is read-only: %s" % APP,
            "The first run installs the server's node_modules there, so it needs to be writable.",
            "Install Colloq into an environment of your own (python3 -m venv ~/colloq && ~/colloq/bin/pip install colloq),",
            "or pip install --user colloq — and run it as yourself.",
        )
    # Замок на случай двух терминалов сразу: npm в одном каталоге двумя
    # процессами — это половина дерева от одного и половина от другого.
    deadline = time.time() + LOCK_WAIT_SEC
    while True:
        try:
            handle = os.open(str(LOCK), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            if _ready(wanted):
                return
            try:
                stale = time.time() - LOCK.stat().st_mtime > LOCK_WAIT_SEC
            except OSError:
                stale = False
            if stale:
                LOCK.unlink(missing_ok=True)
                continue
            if time.time() > deadline:
                fail(
                    "Another process is already installing the Node environment, and it is taking too long.",
                    "If that process died, remove the lock: rm %s" % LOCK,
                )
            print("Another run is installing the Node environment — waiting…", flush=True)
            time.sleep(2)
            continue
        os.close(handle)
        try:
            if _ready(wanted):
                return
            _install(npm, wanted)
        finally:
            LOCK.unlink(missing_ok=True)
        return


def main() -> int:
    if not ENTRY.is_file() or not MARK.is_file():
        fail(
            "The package carries no built application (%s)." % APP,
            "That happens to a wheel built without `make pack`. Rebuild it: make wheel.",
        )
    node = find_node()
    arguments = sys.argv[1:]
    if not arguments or not set(arguments) & TELLING:
        ensure_modules(node)

    environment = dict(os.environ)
    # Где лежит приложение. Всё остальное — состояние занятия — CLI ищет сам:
    # у него для этого COLLOQ_HOME.
    environment["COLLOQ_APP_DIR"] = str(APP)
    # Каталог, из которого позвали: относительные пути в аргументах
    # (`colloq restore --db backups/…`) должны считаться от него, а не от
    # приложения.
    environment.setdefault("COLLOQ_CWD", os.getcwd())

    argv = [str(node), str(ENTRY)] + arguments
    # Перед подменой процесса — вытолкнуть всё своё: execve не возвращается и
    # ничего не дописывает.
    sys.stdout.flush()
    sys.stderr.flush()
    if os.name == "nt":
        # На Windows execve не заменяет процесс, а порождает второй, и родитель
        # возвращается немедленно: там приходится ждать ребёнка руками.
        return subprocess.call(argv, env=environment)
    os.execve(str(node), argv, environment)


if __name__ == "__main__":
    sys.exit(main())
