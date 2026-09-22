/**
 * Питоновская обвязка, которая едет внутрь одноразового контейнера.
 *
 * Исходники лежат здесь строками, а не файлами рядом, по той же причине, по
 * какой так сделан консилиум (kernel/council-isolation.ts): сборка сервера —
 * это `tsc`, и `.py` из `server/src` в `dist` не попадает. Строка переживает
 * сборку, контейнерную форму и установку из пакета, а лишний шаг «не забыть
 * скопировать» не переживает ничего.
 *
 * Перед прогоном обвязка МАТЕРИАЛИЗУЕТСЯ на диск — в `<DATA_DIR>/competitions/
 * .harness/<хэш содержимого>/`, и это не прихоть, а два требования сразу.
 *
 * Первое: путь обязан быть переводим в путь хоста. Под `make up` сервер сам
 * сидит в контейнере, и `-v /app/competitions/harness:/harness` отдал бы
 * посылке каталог, заведённый демоном на лету, — то есть пустой. Всё, что
 * монтируется, обязано лежать внутри DATA_DIR, у которой есть `DATA_HOST_DIR`
 * (storage.ts · hostPathOf).
 *
 * Второе: имя каталога не должно повторяться после изменения содержимого. На
 * colima (virtiofs) каталог, снесённый и заведённый заново под тем же именем,
 * минуту отвечает изнутри «Directory nonexistent» — и посылка молча не видит
 * обвязки. Хэш в имени означает, что новая версия обвязки — это новый путь, а
 * старый никто не трогает.
 *
 * Точка в начале имени (`.harness`) выбрана не для красоты: `sweepOrphans`
 * (storage.ts) сносит из корня всё, что похоже на идентификатор соревнования и
 * не числится живым, а его правило букв ведущей точки не допускает. Каталог
 * обвязки переживёт любую уборку.
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { competitionsDir, competitionsFs } from './storage.js'

/**
 * Исполнение тетради участника — nbclient без живого ядра комнаты.
 *
 * Три вещи, ради которых это не `jupyter nbconvert --execute` одной строкой,
 * и каждая куплена опытом прототипа.
 *
 * Маячок. Контейнер убивают СНАРУЖИ, и ни одна строка после `docker kill` не
 * исполняется — значит, «на какой ячейке остановились» обязано лежать на диске
 * ХОСТА до начала ячейки, а не после неё.
 *
 * Потолок печати. `NotebookClient` копит выводы в объекте тетради: ячейка,
 * печатающая гигабайты, убивает не себя, а контейнер — по памяти, и причина в
 * журнале выглядит как нехватка памяти на обучении. Поэтому `output()`
 * перекрыт: после потолка кадры с сокета читаются дальше (иначе ядро встанет на
 * его буфере), но в память не кладутся.
 *
 * Копия ответа. `/out` — это tmpfs, он умирает вместе с контейнером, и
 * `docker cp` из остановленного его уже не видит (проверено). Забрать файл
 * может только сам контейнер, изнутри и до своей смерти.
 */
const RUN_NOTEBOOK = `"""Исполнение присланной тетради внутри одноразового контейнера."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import venv
import sys
import time
import traceback
from pathlib import Path

import nbformat
from nbclient import NotebookClient
from nbclient.exceptions import CellExecutionError, CellTimeoutError, DeadKernelError


def env_int(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


NOTEBOOK = Path(os.environ.get("COMP_NOTEBOOK", "/submission/notebook.ipynb"))
# Рабочая папка тетради: tmpfs с ЖЁСТКИМ потолком. Диска хоста в ней нет ни
# байта, и «пишу терабайт» кончается на ENOSPC в ячейке участника.
OUT = Path(os.environ.get("COMP_OUT", "/out"))
DATA = Path(os.environ.get("COMP_DATA", "/data"))
# Крошечная папка на диске ХОСТА: маячок, итог, исполненная тетрадь и копия
# ответа, которую обвязка кладёт сюда сама, проверив размер.
RESULT = Path(os.environ.get("COMP_RESULT", "/result"))
TARGET = os.environ.get("COMP_TARGET", "submission.csv")
MAX_OUTPUT = env_int("COMP_MAX_OUTPUT_BYTES", 2_000_000)
MAX_TARGET = env_int("COMP_MAX_TARGET_BYTES", 64 * 1024 * 1024)
# Потолок ОДНОЙ ячейки. Общий срок держит хост: внутренний таймер не переживёт
# ячейку, захватившую GIL в сишном цикле.
CELL_TIMEOUT = env_int("COMP_CELL_TIMEOUT_SEC", 0) or None

PROGRESS = RESULT / "progress.json"
RUN_JSON = RESULT / "run.json"


def write_json(path: Path, payload: dict) -> None:
    """Запись, переживающая убийство контейнера в следующую миллисекунду."""
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


class Runner(NotebookClient):
    """NotebookClient с маячком, потолком вывода и присмотром за ответом."""

    def __init__(self, nb, **kwargs):
        super().__init__(nb, **kwargs)
        self.cells_total = sum(1 for c in nb.cells if c.cell_type == "code")
        self.code_indices = {
            index: order for order, index in enumerate(
                i for i, cell in enumerate(nb.cells) if cell.cell_type == "code"
            )
        }
        self.cell_index = -1
        self.output_bytes = 0
        self.output_truncated = False
        self.started = time.monotonic()
        self.cell_times: list[float] = []
        self._cell_started = 0.0
        self.oversize: str | None = None

    def beat(self, phase: str) -> None:
        write_json(
            PROGRESS,
            {
                "phase": phase,
                "cell": self.cell_index,
                "cells": self.cells_total,
                "elapsed": round(time.monotonic() - self.started, 3),
                "outputBytes": self.output_bytes,
                "outputTruncated": self.output_truncated,
            },
        )

    def on_cell_start(self, cell=None, cell_index=None, **kwargs):  # noqa: ARG002
        if cell_index not in self.code_indices:
            return
        self.cell_index = self.code_indices[cell_index]
        self._cell_started = time.monotonic()
        self.beat("cell")

    def on_cell_executed(self, cell=None, cell_index=None, **kwargs):  # noqa: ARG002
        self.cell_times.append(round(time.monotonic() - self._cell_started, 3))
        # Размер ответа проверяется МЕЖДУ ячейками: ulimit fsize обрывает запись
        # жёстко и без объяснений, а здесь ещё можно назвать причину.
        target = OUT / TARGET
        try:
            size = target.stat().st_size
        except OSError:
            size = 0
        if size > MAX_TARGET:
            self.oversize = f"{TARGET}: {size} bytes > {MAX_TARGET}"
            raise SystemExit(90)
        self.beat("done")

    def output(self, outs, msg, display_id, cell_index):
        content = msg.get("content") or {}
        chunk = content.get("text")
        if chunk is None:
            data = content.get("data") or {}
            chunk = "".join(str(v) for v in data.values()) if data else ""
            if not chunk and content.get("evalue"):
                chunk = str(content["evalue"])
        self.output_bytes += len(chunk.encode("utf-8", "replace"))
        if self.output_bytes > MAX_OUTPUT:
            if not self.output_truncated:
                self.output_truncated = True
                self.beat("truncated")
            return None
        return super().output(outs, msg, display_id, cell_index)


def read_peak() -> int | None:
    """Пик памяти cgroup, снятый изнутри, — пока контейнер ещё жив."""
    for path in ("/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory/memory.max_usage_in_bytes"):
        try:
            return int(Path(path).read_text().strip())
        except (OSError, ValueError):
            continue
    return None


def prepare_workspace() -> None:
    """Expose the read-only dataset at the documented relative path data/."""
    OUT.mkdir(parents=True, exist_ok=True)
    RESULT.mkdir(parents=True, exist_ok=True)
    link = OUT / "data"
    if not link.is_symlink():
        link.symlink_to(DATA, target_is_directory=True)


def cell_error_detail(exc: Exception) -> str:
    """Plain text for the UI, keeping the final exception even in a long trace."""
    text = re.sub(r"\\x1b\\[[0-?]*[ -/]*[@-~]", "", str(exc))
    return "\\n".join(text.splitlines()[-25:])[-4000:]


def dependency_command(args: list[str]) -> None:
    """Bound installation output on disk and retain only its useful tail."""
    with tempfile.TemporaryFile() as log:
        completed = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        if completed.returncode:
            log.seek(0, os.SEEK_END)
            log.seek(max(0, log.tell() - 6000))
            detail = log.read().decode("utf-8", "replace")
            raise RuntimeError(cell_error_detail(RuntimeError(detail)) or f"Installer exited with {completed.returncode}")


def prepare_dependencies() -> str:
    """Install a published bundle offline and return its exact kernel name."""
    directory = os.environ.get("COMP_DEPENDENCIES")
    if not directory:
        return "python3"
    dependencies = Path(directory)
    environment = OUT / ".colloq-venv"
    # Reuse base pip to avoid copying its wheels into every temporary venv.
    venv.EnvBuilder(system_site_packages=True, with_pip=False).create(environment)
    python = environment / "bin" / "python"
    dependency_command([
        sys.executable, "-I", "-m", "pip", "--isolated", "--disable-pip-version-check",
        "--python", str(python), "install", "--no-index", "--no-deps", "--no-cache-dir",
        "--no-compile", "--only-binary=:all:", "--require-hashes", "--find-links", str(dependencies / "wheels"),
        "-r", str(dependencies / "requirements.lock"),
    ])
    # An existing base python3 kernelspec may contain an absolute base Python.
    # Use a distinct spec with an absolute venv interpreter; PATH is insufficient.
    kernel_name = "colloq-dependencies"
    jupyter_data = Path(os.environ.get("JUPYTER_DATA_DIR") or str(OUT / ".jupyter"))
    os.environ["JUPYTER_DATA_DIR"] = str(jupyter_data)
    kernel_dir = jupyter_data / "kernels" / kernel_name
    kernel_dir.mkdir(parents=True, exist_ok=True)
    (kernel_dir / "kernel.json").write_text(json.dumps({
        "argv": [str(python), "-m", "ipykernel_launcher", "-f", "{connection_file}"],
        "display_name": "Colloq dependency environment",
        "language": "python",
    }), encoding="utf-8")
    return kernel_name


def main() -> int:
    prepare_workspace()
    # HOME указывает в пустую tmpfs, и папки там ещё нет: --tmpfs создаёт только
    # точку монтирования. IPython, не найдя HOME, уходит во временный каталог и
    # печатает об этом предупреждение в КАЖДУЮ посылку.
    for name in ("HOME", "JUPYTER_RUNTIME_DIR", "JUPYTER_DATA_DIR", "MPLCONFIGDIR"):
        target = os.environ.get(name)
        if target:
            Path(target).mkdir(parents=True, exist_ok=True)
    started_wall = time.time()

    status = "ok"
    detail = ""
    runner = None
    try:
        nb = nbformat.read(NOTEBOOK, as_version=4)
    except Exception as exc:  # noqa: BLE001
        # Битый JSON или не тетрадь вовсе: это отказ участнику, и он обязан
        # прочитать его дословно — до первой ячейки дело не дошло.
        write_json(
            RUN_JSON,
            {
                "status": "notebook_unreadable",
                "detail": f"{type(exc).__name__}: {exc}",
                "cell": -1,
                "cells": 0,
                "wall": round(time.time() - started_wall, 3),
            },
        )
        return 1

    if os.environ.get("COMP_DEPENDENCIES"):
        write_json(PROGRESS, {"phase": "dependencies", "cell": -1, "cells": 0, "outputBytes": 0})
    try:
        kernel_name = prepare_dependencies()
    except Exception as exc:  # noqa: BLE001
        write_json(RUN_JSON, {
            "status": "dependency_error",
            "detail": cell_error_detail(exc),
            "cell": -1,
            "cells": 0,
            "wall": round(time.time() - started_wall, 3),
            "peakBytes": read_peak(),
        })
        return 1

    runner = Runner(
        nb,
        timeout=CELL_TIMEOUT,
        kernel_name=kernel_name,
        allow_errors=False,
        force_raise_errors=True,
        # Рабочая папка тетради — записываемая /out: участник пишет ответ
        # относительным путём, как он привык.
        resources={"metadata": {"path": str(OUT)}},
    )
    runner.beat("start")

    try:
        runner.execute()
    except SystemExit as exc:
        status = "target_too_large" if exc.code == 90 else "exit"
        detail = runner.oversize or f"SystemExit({exc.code})"
    except CellTimeoutError as exc:
        status = "cell_timeout"
        detail = str(exc).splitlines()[0][:400]
    except DeadKernelError as exc:
        status = "kernel_died"
        detail = str(exc).splitlines()[0][:400]
    except CellExecutionError as exc:
        status = "cell_error"
        # Участнику это показывают дословно: его собственная ошибка.
        detail = cell_error_detail(exc)
    except Exception as exc:  # noqa: BLE001
        status = "harness_error"
        detail = f"{type(exc).__name__}: {exc}\\n{traceback.format_exc()[-2000:]}"

    # Исполненная тетрадь — это то, что участник откроет на странице посылки:
    # его код, его вывод, его трассировка на упавшей ячейке. Выводы в ней уже
    # подрезаны потолком, поэтому записать её можно, не боясь гигабайтов.
    try:
        nbformat.write(nb, RESULT / "executed.ipynb")
    except Exception as exc:  # noqa: BLE001
        detail = f"{detail}\\n[executed.ipynb not written: {type(exc).__name__}]".strip()

    target = OUT / TARGET
    try:
        size = target.stat().st_size
    except OSError:
        size = None
    else:
        if status == "ok":
            if size > MAX_TARGET:
                status, detail = "target_too_large", f"{TARGET}: {size} bytes > {MAX_TARGET}"
            else:
                try:
                    shutil.copyfile(target, RESULT / TARGET)
                except OSError as exc:
                    status, detail = "target_unreadable", f"{type(exc).__name__}: {exc}"

    write_json(
        RUN_JSON,
        {
            "status": status,
            "detail": detail,
            "cell": runner.cell_index,
            "cells": runner.cells_total,
            "cellTimes": runner.cell_times,
            "wall": round(time.time() - started_wall, 3),
            "outputBytes": runner.output_bytes,
            "outputTruncated": runner.output_truncated,
            "targetBytes": size,
            "peakBytes": read_peak(),
        },
    )
    runner.beat("finished")
    # Ноль — «тетрадь исполнилась»; всё прочее разбирает хост по run.json.
    return 0 if status == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
`

/**
 * Единственный модуль, который импортирует код метрики преподавателя.
 *
 * `ParticipantVisibleError` — договор с участником: текст такой ошибки он
 * читает дословно, а любое другое исключение не видит вовсе. Отдельным
 * импортируемым именем, а не проверкой текста (как `kaggle_metric_utilities`):
 * преподаватель должен уметь сказать «это участнику» однозначно, а не гадать,
 * какая формулировка просочится наружу.
 */
const COLLOQ_METRIC = `"""Что код метрики импортирует у нас."""


class ParticipantVisibleError(Exception):
    """Ошибка, текст которой показывают участнику дословно."""
`

/**
 * Деление строк на публичную и приватную часть — ВТОРАЯ КОПИЯ одного правила.
 *
 * Первая живёт в `@shared/competitions` (splitRows, splitByUsage,
 * publicRowCount) и отвечает на вопрос страницы: «119 строк считаются сразу,
 * 278 — после дедлайна». Вторая — здесь, и по ней метрика на самом деле делит
 * ответы. Разойдясь, они не упадут: страница скажет одно, лидерборд посчитает
 * другое, и заметит это тот, кто пересчитает строки руками.
 *
 * Поэтому копия лежит ОТДЕЛЬНЫМ модулем, без pandas и без единого импорта
 * тяжелее `math`: её можно запустить голым python и сверить с первой копией
 * прямо в сюите (tests/competitions-runner) — что и делается, и что уже
 * поймало разъехавшийся разделитель зерна.
 */
const COLLOQ_SPLIT = `"""Деление строк ответов — копия правила из @shared/competitions."""

from __future__ import annotations

import math

"""
Чем склеены зерно и идентификатор строки.

Нулевой байт, а не пробел, и это не мелочь: идентификатор приходит из файла
преподавателя и может содержать что угодно, включая пробел. С пробелом пара
(«a», «b c») и пара («a b», «c») дали бы один хэш, то есть строки с разными
ключами попали бы в одну ячейку. Ноля в идентификаторе не бывает.
"""
SEED_SEPARATOR = "\\x00"


def code_units(text: str):
    """
    Кодовые единицы UTF-16 — то, по чему считает String.charCodeAt.

    Мелочь, без которой хэш разошёлся бы ровно на тех задачах, где
    идентификатор строки не латиница: Python ходит по кодовым ТОЧКАМ, и на
    символе вне BMP он выдал бы одно число там, где браузер выдаёт два.
    """
    for ch in text:
        point = ord(ch)
        if point > 0xFFFF:
            point -= 0x10000
            yield 0xD800 + (point >> 10)
            yield 0xDC00 + (point & 0x3FF)
        else:
            yield point


def hash32(value: str) -> int:
    """FNV-1a, 32 бита — тот же, что в shared/competitions.ts."""
    result = 0x811C9DC5
    for unit in code_units(value):
        result ^= unit
        result = (result * 0x01000193) & 0xFFFFFFFF
    return result


def public_row_count(total: int, percent: float) -> int:
    """Сколько строк считать сразу; обе части обязаны быть непусты."""
    if total <= 0:
        return 0
    if total == 1:
        return 1
    # Math.round округляет половину ВВЕРХ, а round() в Python — к чётному.
    wanted = math.floor(total * percent / 100 + 0.5)
    return min(total - 1, max(1, wanted))


def split_rows(ids: list[str], percent: float, seed: str) -> list[str]:
    """Ранг по хэшу, а не жребий по строке: доля обязана дать ровно своё число."""
    take = public_row_count(len(ids), percent)
    order = sorted(
        (
            (hash32(seed + SEED_SEPARATOR + row_id), row_id, index)
            for index, row_id in enumerate(ids)
        ),
        key=lambda item: (item[0], item[1]),
    )
    parts = ["private"] * len(ids)
    for hashed, row_id, index in order[:take]:  # noqa: B007
        parts[index] = "public"
    return parts


def split_by_usage(usage: list[str]) -> list[str] | None:
    """Деление, записанное преподавателем; None — колонка не годится."""
    parts: list[str] = []
    public_rows = 0
    for raw in usage:
        value = str(raw).strip().lower()
        if value == "public":
            parts.append("public")
            public_rows += 1
        elif value == "private":
            parts.append("private")
        else:
            return None
    if public_rows == 0 or public_rows == len(parts):
        return None
    return parts
`

/**
 * Метрика преподавателя — ОТДЕЛЬНЫМ контейнером, в котором участника нет.
 *
 * Деление строк здесь — ДОСЛОВНЫЙ перенос `@shared/competitions` (splitRows,
 * splitByUsage, publicRowCount), и это главное, что отличает его от прототипа.
 * Тот делил `solution.sample(random_state=seed)`, то есть по-своему, а браузер
 * тем временем рисовал «119 строк считаются сразу» по своему правилу. Две
 * копии одного деления, которые не сходятся, не падают — они тихо врут, и
 * замечает это тот, кто пересчитал число строк руками. Поэтому здесь
 * повторён ровно тот хэш, ровно тот порядок и ровно то округление.
 *
 * Наружу — только `/out/score.json`, не stdout: код преподавателя вправе
 * печатать что угодно, и разбирать его печать вперемешку со своей значит
 * однажды показать участнику строку из метрики.
 */
const SCORE_METRIC = `"""Метрика преподавателя в отдельном одноразовом контейнере."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import time
import traceback
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from colloq_metric import ParticipantVisibleError  # noqa: E402
from colloq_split import split_by_usage, split_rows  # noqa: E402

SOLUTION = Path(os.environ.get("COMP_SOLUTION", "/secret/solution.csv"))
SUBMISSION = Path(os.environ.get("COMP_SUBMISSION", "/submission/submission.csv"))
METRIC = Path(os.environ.get("COMP_METRIC", "/secret/metric.py"))
OUT = Path(os.environ.get("COMP_OUT", "/out"))
ID_COLUMN = os.environ.get("COMP_ID_COLUMN", "id")
USAGE_COLUMN = os.environ.get("COMP_USAGE_COLUMN", "Usage")
PUBLIC_PERCENT = float(os.environ.get("COMP_PUBLIC_PERCENT", "30"))
SPLIT_SEED = os.environ.get("COMP_SPLIT_SEED", "")


def load_metric():
    """Код преподавателя как модуль — без exec() и без общей области имён."""
    spec = importlib.util.spec_from_file_location("colloq_teacher_metric", METRIC)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load metric from {METRIC}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if not hasattr(module, "score"):
        raise RuntimeError("metric.py defines no score(solution, submission)")
    return module.score


def plan_split(solution: pd.DataFrame) -> list[str]:
    """
    Колонкой, если преподаватель её дал и она годна, иначе зерном.

    Колонка старше зерна: разметив строки руками, он обычно делит их по смыслу
    — по времени, по складу, по пациенту, — и подменять такое деление жребием
    значит испортить задачу.
    """
    if USAGE_COLUMN in solution.columns:
        by_usage = split_by_usage(solution[USAGE_COLUMN].tolist())
        if by_usage is not None:
            return by_usage
    return split_rows(
        [str(value) for value in solution[ID_COLUMN].tolist()], PUBLIC_PERCENT, SPLIT_SEED
    )


def plain(value):
    """
    Питоновский скаляр вместо numpy.

    Участник читает это дословно, а repr numpy-скаляра выглядит как
    «id=np.int64(398692)» — мелочь, которую видит каждый, кто ошибся строкой.
    """
    item = getattr(value, "item", None)
    return item() if callable(item) else value


def align(solution: pd.DataFrame, submission: pd.DataFrame) -> pd.DataFrame:
    """
    Ответ участника, поставленный в порядок ответов, — или понятный отказ.

    Отказ уезжает КОДОМ, а не фразой: текст живёт в shared/locales, потому что
    страница участника бывает на двух языках, а контейнер о языке инстанса не
    знает и знать не должен.
    """
    if ID_COLUMN not in submission.columns:
        raise ParticipantVisibleError(
            json.dumps(
                {
                    "code": "noIdColumn",
                    "params": {
                        "column": ID_COLUMN,
                        "columns": ", ".join(map(str, submission.columns)),
                    },
                }
            )
        )
    if submission[ID_COLUMN].duplicated().any():
        dup = submission.loc[submission[ID_COLUMN].duplicated(), ID_COLUMN].iloc[0]
        raise ParticipantVisibleError(
            json.dumps({"code": "duplicateId", "params": {"column": ID_COLUMN, "example": str(plain(dup))}})
        )
    indexed = submission.set_index(ID_COLUMN)
    want = solution[ID_COLUMN]
    missing = want[~want.isin(indexed.index)]
    if len(missing):
        raise ParticipantVisibleError(
            json.dumps(
                {
                    "code": "missingRows",
                    "params": {
                        "count": int(len(missing)),
                        "column": ID_COLUMN,
                        "example": str(plain(missing.iloc[0])),
                    },
                }
            )
        )
    return indexed.loc[want].reset_index()


def participant_failure(exc: ParticipantVisibleError) -> dict:
    """
    Наша проверка приезжает кодом, ошибка преподавателя — своим текстом.

    Различаются они здесь и только здесь: всё, что метрика подняла сама,
    участник читает слово в слово, а всё, что подняли мы, он читает на своём
    языке.
    """
    text = str(exc)[:1000]
    try:
        asked = json.loads(text)
    except json.JSONDecodeError:
        return {"status": "participant_error", "message": text}
    if isinstance(asked, dict) and isinstance(asked.get("code"), str):
        return {"status": "participant_error", "code": asked["code"], "params": asked.get("params") or {}}
    return {"status": "participant_error", "message": text}


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    result: dict = {"status": "metric_error"}
    started = time.monotonic()
    try:
        solution = pd.read_csv(SOLUTION)
        if ID_COLUMN not in solution.columns:
            raise RuntimeError(f"solution.csv has no column {ID_COLUMN!r}")
        try:
            submission = pd.read_csv(SUBMISSION)
        except Exception as exc:  # noqa: BLE001
            raise ParticipantVisibleError(
                json.dumps({"code": "unparsable", "params": {"reason": f"{type(exc).__name__}: {exc}"[:300]}})
            ) from exc
        scorer = load_metric()
        aligned = align(solution, submission)
        parts = plan_split(solution)
        scores: dict[str, float | None] = {}
        counts: dict[str, int] = {}
        for name in ("public", "private"):
            rows = [index for index, part in enumerate(parts) if part == name]
            counts[name] = len(rows)
            if not rows:
                scores[name] = None
                continue
            value = scorer(
                solution.iloc[rows].drop(columns=[USAGE_COLUMN], errors="ignore").reset_index(drop=True),
                aligned.iloc[rows].reset_index(drop=True),
            )
            value = float(value)
            if value != value or value in (float("inf"), float("-inf")):
                raise RuntimeError(f"score() returned {value!r} on the {name} rows")
            scores[name] = value
        result = {
            "status": "ok",
            "public": scores.get("public"),
            "private": scores.get("private"),
            "rows": counts,
        }
    except ParticipantVisibleError as exc:
        result = participant_failure(exc)
    except Exception as exc:  # noqa: BLE001
        # Только преподавателю: в трассировке лежат строки его метрики и,
        # бывает, куски ответов.
        result = {
            "status": "metric_error",
            "teacherOnly": f"{type(exc).__name__}: {exc}\\n{traceback.format_exc()[-4000:]}",
        }
    result["wall"] = round(time.monotonic() - started, 3)
    (OUT / "score.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
`

/** Что лежит в каталоге обвязки: имя файла — то, чем его зовут в контейнере. */
const FILES: ReadonlyArray<readonly [string, string]> = [
  ['run_notebook.py', RUN_NOTEBOOK],
  ['score_metric.py', SCORE_METRIC],
  ['colloq_metric.py', COLLOQ_METRIC],
  ['colloq_split.py', COLLOQ_SPLIT],
]

/** Исходник модуля деления — сюите, которая сверяет его с `@shared/competitions`. */
export const SPLIT_SOURCE = COLLOQ_SPLIT

/**
 * Версия обвязки — хэш её содержимого, а не число в константе.
 *
 * Руками проставленная версия забывается ровно в том случае, ради которого она
 * и нужна: правка на одну строку, выкаченная на машину, где старый каталог
 * обвязки уже лежит. Хэш не забывается.
 */
export const HARNESS_REVISION = createHash('sha256')
  .update(FILES.map(([name, body]) => `${name}\n${body}`).join('\n'))
  .digest('hex')
  .slice(0, 12)

let materialized: string | null = null

/**
 * Разложить обвязку на диск и вернуть каталог, который монтируют в контейнер.
 *
 * Идемпотентно и считается один раз на процесс: файлы не меняются между
 * посылками, а три записи на каждую посылку — это три записи в каталог,
 * смонтированный в идущий контейнер соседа.
 */
export function harnessDir(): string {
  if (materialized) return materialized
  const dir = path.join(competitionsDir, '.harness', HARNESS_REVISION)
  competitionsFs.mkdirSync(dir, { recursive: true })
  for (const [name, body] of FILES) {
    const file = path.join(dir, name)
    // Уже лежит — не переписываем: у каталога с хэшем в имени содержимое либо
    // то же самое, либо его там нет вовсе.
    if (competitionsFs.existsSync(file)) continue
    competitionsFs.writeFileSync(file, Buffer.from(body, 'utf8'), { mode: 0o644 })
  }
  materialized = dir
  return dir
}

/** Забыть разложенное — тестам, которые меняют DATA_DIR под ногами. */
export function forgetHarness(): void {
  materialized = null
}
