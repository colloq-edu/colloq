/**
 * The Python harness that travels into a disposable container.
 *
 * The sources live here as strings rather than as files alongside, for the
 * same reason the council is done this way (kernel/council-isolation.ts): the
 * server build is `tsc`, and a `.py` from `server/src` does not reach `dist`.
 * A string survives the build, the container form and installation from a
 * package, while an extra "don't forget to copy" step survives nothing.
 *
 * Before a run the harness is MATERIALIZED on disk — in
 * `<DATA_DIR>/competitions/.harness/<content hash>/`, and that is not a whim
 * but two requirements at once.
 *
 * First: the path must be translatable into a host path. Under `make up` the
 * server itself sits in a container, and
 * `-v /app/competitions/harness:/harness` would give the submission a
 * directory the daemon created on the fly — that is, an empty one. Everything
 * that is mounted must lie inside DATA_DIR, which has `DATA_HOST_DIR`
 * (storage.ts · hostPathOf).
 *
 * Second: the directory name must not repeat after the content changes. On
 * colima (virtiofs) a directory removed and created again under the same name
 * answers "Directory nonexistent" from inside for a minute — and the
 * submission silently does not see the harness. A hash in the name means that
 * a new version of the harness is a new path, and nobody touches the old one.
 *
 * The leading dot in the name (`.harness`) was not chosen for looks:
 * `sweepOrphans` (storage.ts) removes from the root everything that looks like
 * a competition id and is not listed as live, and its letter rule does not
 * allow a leading dot. The harness directory survives any cleanup.
 */
import { createHash } from 'node:crypto'
import path from 'node:path'
import { competitionsDir, competitionsFs } from './storage.js'

/**
 * Executing the participant's notebook — nbclient without a live room kernel.
 *
 * Three things for which this is not a one-line `jupyter nbconvert --execute`,
 * and each was bought by the prototype's experience.
 *
 * The beacon. The container is killed from OUTSIDE, and not a single line runs
 * after `docker kill` — so "which cell we stopped at" must be on the HOST disk
 * before the cell starts, not after it.
 *
 * The print cap. `NotebookClient` accumulates outputs in the notebook object:
 * a cell printing gigabytes kills not itself but the container — for memory,
 * and the reason in the log looks like running out of memory during training.
 * So `output()` is overridden: past the cap, frames from the socket keep being
 * read (otherwise the kernel stalls on its buffer), but they are not kept in
 * memory.
 *
 * A copy of the answer. `/out` is a tmpfs, it dies together with the
 * container, and `docker cp` from a stopped container no longer sees it
 * (verified). Only the container itself can take the file out, from inside
 * and before its death.
 */
const RUN_NOTEBOOK = `"""Executing a submitted notebook inside a disposable container."""

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
# The notebook's working folder: a tmpfs with a HARD cap. It holds not a single
# byte of the host disk, and "I'll write a terabyte" ends in ENOSPC in the
# participant's cell.
OUT = Path(os.environ.get("COMP_OUT", "/out"))
DATA = Path(os.environ.get("COMP_DATA", "/data"))
# A tiny folder on the HOST disk: the beacon, the result, the executed notebook
# and a copy of the answer, which the harness puts here itself after checking
# its size.
RESULT = Path(os.environ.get("COMP_RESULT", "/result"))
TARGET = os.environ.get("COMP_TARGET", "submission.csv")
MAX_OUTPUT = env_int("COMP_MAX_OUTPUT_BYTES", 2_000_000)
MAX_OUTPUT_KILL = env_int("COMP_MAX_OUTPUT_KILL_BYTES", 64 * 1024 * 1024)
MAX_TARGET = env_int("COMP_MAX_TARGET_BYTES", 64 * 1024 * 1024)
# The cap on ONE cell. The host holds the overall time limit: an internal timer
# will not survive a cell that grabbed the GIL in a C loop.
CELL_TIMEOUT = env_int("COMP_CELL_TIMEOUT_SEC", 0) or None

PROGRESS = RESULT / "progress.json"
RUN_JSON = RESULT / "run.json"


def write_json(path: Path, payload: dict) -> None:
    """A write that survives the container being killed a millisecond later."""
    payload["attemptId"] = os.environ.get("COMP_ATTEMPT_ID", "")
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


class Runner(NotebookClient):
    """NotebookClient with a beacon, an output cap and a watch over the answer."""

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
        self._output_beat_at = time.monotonic()
        self._hard_output_reported = False
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
        # The answer's size is checked BETWEEN cells: ulimit fsize cuts a write
        # off hard and without explanation, while here we can still name the
        # reason.
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
        if content.get("traceback"):
            chunk = str(chunk) + "\\n".join(str(line) for line in content["traceback"])
        self.output_bytes += len(str(chunk).encode("utf-8", "replace"))
        if self.output_bytes > MAX_OUTPUT:
            now = time.monotonic()
            crossed = self.output_bytes > globals().get("MAX_OUTPUT_KILL", 64 * 1024 * 1024) and not self._hard_output_reported
            if not self.output_truncated or crossed or now - self._output_beat_at >= 0.25:
                self.output_truncated = True
                self._hard_output_reported = self._hard_output_reported or crossed
                self._output_beat_at = now
                self.beat("truncated")
            return None
        return super().output(outs, msg, display_id, cell_index)


def read_peak() -> int | None:
    """The cgroup memory peak, read from inside while the container is still alive."""
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
    # HOME points into an empty tmpfs, and the folder is not there yet: --tmpfs
    # creates only the mount point. IPython, not finding HOME, falls back to a
    # temporary directory and prints a warning about it into EVERY submission.
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
        # Broken JSON or not a notebook at all: this is a refusal to the
        # participant, and they must read it verbatim — things never got as far
        # as the first cell.
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
        # The notebook's working folder is the writable /out: the participant
        # writes the answer with a relative path, as they are used to.
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
        # This is shown to the participant verbatim: it is their own error.
        detail = cell_error_detail(exc)
    except Exception as exc:  # noqa: BLE001
        status = "harness_error"
        detail = f"{type(exc).__name__}: {exc}\\n{traceback.format_exc()[-2000:]}"

    # The executed notebook is what the participant opens on the submission
    # page: their code, their output, their traceback on the failed cell. The
    # outputs in it are already trimmed by the cap, so it can be written
    # without fear of gigabytes.
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
    # Zero means "the notebook ran"; the host sorts out everything else from run.json.
    return 0 if status == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
`

/**
 * The only module of ours that the teacher's metric code imports.
 *
 * `ParticipantVisibleError` is a contract with the participant: they read the
 * text of such an error verbatim, and any other exception they do not see at
 * all. A separate importable name rather than a check of the text (as in
 * `kaggle_metric_utilities`): the teacher must be able to say "this is for the
 * participant" unambiguously, not guess which wording will leak outside.
 */
const COLLOQ_METRIC = `"""What the metric code imports from us."""


class ParticipantVisibleError(Exception):
    """An error whose text is shown to the participant verbatim."""
`

/**
 * Splitting rows into the public and private part — the SECOND COPY of one
 * rule.
 *
 * The first lives in `@shared/competitions` (splitRows, splitByUsage,
 * publicRowCount) and answers the page's question: "119 rows are scored right
 * away, 278 after the deadline". The second is here, and it is what the metric
 * actually uses to split the answers. If they diverge, nothing will crash: the
 * page will say one thing, the leaderboard will compute another, and the one
 * to notice will be whoever recounts the rows by hand.
 *
 * So the copy lives in a SEPARATE module, without pandas and without a single
 * import heavier than `math`: it can be run with bare python and checked
 * against the first copy right in the suite (tests/competitions-runner) —
 * which is what is done, and what has already caught a drifted seed
 * separator.
 */
const COLLOQ_SPLIT = `"""Splitting answer rows: a copy of the @shared/competitions rule."""

from __future__ import annotations

import math

"""
What joins the seed and the row id.

A null byte, not a space, and that is no trifle: the id comes from the
teacher's file and may contain anything, including a space. With a space the
pair ("a", "b c") and the pair ("a b", "c") would give the same hash, that is,
rows with different keys would land in the same slot. A null never occurs in
an id.
"""
SEED_SEPARATOR = "\\x00"


def code_units(text: str):
    """
    UTF-16 code units — what String.charCodeAt counts by.

    A detail without which the hash would diverge on exactly those tasks where
    the row id is not Latin: Python walks code POINTS, and on a character
    outside the BMP it would produce one number where the browser produces
    two.
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
    """FNV-1a, 32 bits — the same as in shared/competitions.ts."""
    result = 0x811C9DC5
    for unit in code_units(value):
        result ^= unit
        result = (result * 0x01000193) & 0xFFFFFFFF
    return result


def public_row_count(total: int, percent: float) -> int:
    """How many rows to score right away; both parts must be non-empty."""
    if total <= 0:
        return 0
    if total == 1:
        return 1
    # Math.round rounds half UP, while Python's round() rounds to even.
    wanted = math.floor(total * percent / 100 + 0.5)
    return min(total - 1, max(1, wanted))


def split_rows(ids: list[str], percent: float, seed: str) -> list[str]:
    """Rank by hash, not a lottery per row: the share must give exactly its number."""
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
    """The split written down by the teacher; None means the column is unusable."""
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
 * The teacher's metric — in a SEPARATE container with no participant in it.
 *
 * The row split here is a WORD-FOR-WORD port of `@shared/competitions`
 * (splitRows, splitByUsage, publicRowCount), and that is the main thing that
 * sets it apart from the prototype. The prototype split with
 * `solution.sample(random_state=seed)`, that is, in its own way, while the
 * browser meanwhile drew "119 rows are scored right away" by its own rule. Two
 * copies of one split that disagree do not crash — they quietly lie, and the
 * one who notices is whoever recounted the rows by hand. So exactly the same
 * hash, exactly the same order and exactly the same rounding are repeated
 * here.
 *
 * Only `/out/score.json` goes outside, not stdout: the teacher's code is free
 * to print anything, and parsing its printing mixed with our own means one day
 * showing the participant a line from the metric.
 */
const SCORE_METRIC = `"""The teacher's metric in a separate disposable container."""

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
    """The teacher's code as a module — no exec(), no shared namespace."""
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
    By the column, if the teacher provided one and it is usable, otherwise by
    the seed.

    The column outranks the seed: having labelled the rows by hand, the teacher
    usually splits them by meaning — by time, by warehouse, by patient — and
    replacing such a split with a lottery would spoil the task.
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
    A Python scalar instead of a numpy one.

    The participant reads this verbatim, and the repr of a numpy scalar looks
    like "id=np.int64(398692)" — a trifle seen by everyone who got a row wrong.
    """
    item = getattr(value, "item", None)
    return item() if callable(item) else value


def align(solution: pd.DataFrame, submission: pd.DataFrame) -> pd.DataFrame:
    """
    The participant's answer put in the order of the answer key — or a clear
    refusal.

    The refusal leaves as a CODE, not a sentence: the text lives in
    shared/locales, because the participant's page comes in two languages, and
    the container does not know the instance's language and must not.
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
    Our check arrives as a code, the teacher's error as its own text.

    They are told apart here and only here: everything the metric raised itself
    the participant reads word for word, and everything we raised they read in
    their own language.
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
        # Only for the teacher: the traceback holds lines of their metric and,
        # sometimes, pieces of the answers.
        result = {
            "status": "metric_error",
            "teacherOnly": f"{type(exc).__name__}: {exc}\\n{traceback.format_exc()[-4000:]}",
        }
    result["wall"] = round(time.monotonic() - started, 3)
    result["attemptId"] = os.environ.get("COMP_ATTEMPT_ID", "")
    (OUT / "score.json").write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return 0 if result["status"] == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
`

// Keep bounded tmpfs alive until the host has collected named artifacts. No
// participant-writable directory is ever mounted from the host. The host owns
// the wall timeout and always removes this supervisor, including cancellation.
const HOLD_EXPORT = `import json, os, subprocess, sys, time
from pathlib import Path
directory = Path(sys.argv[1])
directory.mkdir(parents=True, exist_ok=True)
child = subprocess.run([sys.executable, sys.argv[2]])
temporary = directory / ".complete-next"
temporary.write_text(json.dumps({"attemptId": os.environ["COMP_ATTEMPT_ID"], "exit": child.returncode}))
os.replace(temporary, directory / ".complete.json")
while True:
    time.sleep(60)
`

// Invoked by docker exec. Open a bounded regular file through a descriptor;
// never tar or recursively copy attacker-controlled result trees to the host.
const EXPORT_FILES = `import base64, json, os, stat, sys
from pathlib import Path
root = Path(sys.argv[2])
allowed = {"progress.json": 65536, "run.json": 65536, "score.json": 1048576,
           ".complete.json": 4096, "submission.csv": int(os.environ.get("COMP_MAX_TARGET_BYTES", 67108864)),
           "executed.ipynb": 67108864}
def read(name):
    maximum = allowed[name]
    fd = os.open(str(root / name), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
            raise ValueError("invalid export")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            body = stream.read(maximum + 1)
        if len(body) > maximum:
            raise ValueError("export grew beyond limit")
        return body
    finally:
        os.close(fd)
if sys.argv[1] == "status":
    value = {}
    for key, name in (("progress", "progress.json"), ("complete", ".complete.json")):
        try:
            value[key] = json.loads(read(name))
        except (OSError, ValueError):
            pass
    print(json.dumps(value))
else:
    name = sys.argv[3]
    if name not in allowed or name == ".complete.json":
        raise ValueError("unknown export")
    sys.stdout.write(base64.b64encode(read(name)).decode("ascii"))
`

/** What lies in the harness directory: the file name is what the container calls it. */
const FILES: ReadonlyArray<readonly [string, string]> = [
  ['run_notebook.py', RUN_NOTEBOOK],
  ['score_metric.py', SCORE_METRIC],
  ['hold_export.py', HOLD_EXPORT],
  ['export_files.py', EXPORT_FILES],
  ['colloq_metric.py', COLLOQ_METRIC],
  ['colloq_split.py', COLLOQ_SPLIT],
  ['broker_score.py', String.raw`import json, os, runpy
from pathlib import Path
config = json.loads(Path('/config/request.json').read_text(encoding='utf-8'))
assert set(config) == {'idColumn', 'publicPercent', 'splitSeed'}
assert config['idColumn'] == 'id'
assert isinstance(config['publicPercent'], int) and 0 <= config['publicPercent'] <= 100
assert isinstance(config['splitSeed'], str) and len(config['splitSeed']) <= 256
os.environ['COMP_ID_COLUMN'] = config['idColumn']
os.environ['COMP_PUBLIC_PERCENT'] = str(config['publicPercent'])
os.environ['COMP_SPLIT_SEED'] = config['splitSeed']
runpy.run_path('/harness/score_metric.py', run_name='__main__')
`],
]

/**
 * The source of the split module — for the suite that checks it against
 * `@shared/competitions`.
 */
export const SPLIT_SOURCE = COLLOQ_SPLIT

/**
 * The harness version is the hash of its content, not a number in a constant.
 *
 * A hand-set version is forgotten in exactly the case it exists for: a
 * one-line fix rolled out to a machine where the old harness directory already
 * lies. A hash is not forgotten.
 */
export const HARNESS_REVISION = createHash('sha256')
  .update(FILES.map(([name, body]) => `${name}\n${body}`).join('\n'))
  .digest('hex')
  .slice(0, 12)

let materialized: string | null = null

/**
 * Lay the harness out on disk and return the directory that is mounted into
 * the container.
 *
 * Idempotent and computed once per process: the files do not change between
 * submissions, and three writes per submission are three writes into a
 * directory mounted into a neighbour's running container.
 */
export function harnessDir(): string {
  if (materialized) return materialized
  const dir = path.join(competitionsDir, '.harness', HARNESS_REVISION)
  competitionsFs.mkdirSync(dir, { recursive: true })
  for (const [name, body] of FILES) {
    const file = path.join(dir, name)
    // Already there, so we do not rewrite it: in a directory with a hash in its
    // name the content is either the same or not there at all.
    if (competitionsFs.existsSync(file)) continue
    competitionsFs.writeFileSync(file, Buffer.from(body, 'utf8'), { mode: 0o644 })
  }
  materialized = dir
  return dir
}

/** Stable PVC subPath used by the private broker's fixed Pod template. */
export function brokerHarnessDir(): string {
  const dir=path.join(competitionsDir,'harness')
  competitionsFs.mkdirSync(dir,{recursive:true})
  competitionsFs.chmodSync(dir,0o755)
  for(const [name,body] of FILES) {
    const file=path.join(dir,name)
    const hash=createHash('sha256').update(body).digest('hex')
    if(competitionsFs.existsSync(file) && createHash('sha256').update(competitionsFs.readFileSync(file) as Buffer).digest('hex')===hash)continue
    const temp=path.join(dir,`.${name}-${HARNESS_REVISION}.tmp`)
    competitionsFs.writeFileSync(temp,Buffer.from(body,'utf8'),{mode:0o644})
    competitionsFs.renameSync(temp,file)
  }
  return dir
}

/** Forget what was laid out — for tests that change DATA_DIR under our feet. */
export function forgetHarness(): void {
  materialized = null
}
