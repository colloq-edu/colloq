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
 *
 * And three more, bought by a class that could never see what its notebooks
 * printed.
 *
 * The executed copy is written whatever the ending, and only with this run's
 * outputs: the notebook arrives with whatever the participant's own Jupyter
 * left in it, and a cell the run never reached must not show a result it
 * never produced here.
 *
 * The time limit is the host's, but the harness stops the notebook itself a
 * few seconds before it (`stop_at`): every cell may wait only for what is left
 * of the run, so nbclient's own timeout interrupts the overrunning one while
 * this process is alive to save the notebook — the finished cells and what
 * the stuck one printed so far. A kill from outside leaves nothing to save,
 * and the timed-out run was exactly the one whose outputs said why.
 *
 * A copy as far as it got is kept on disk while the notebook runs
 * (`Runner.snapshot`), for the day the harness itself dies without a word:
 * the host salvages it before a kill (docker-runner.ts · watch), the broker's
 * exporter collects it after a crash.
 *
 * And the kernel starts with kernel_streams.py loaded (KERNEL_STREAMS below):
 * without it the line a cell printed right before an out-of-memory kill never
 * reached the executed notebook, while the same line before a timeout did.
 */
const RUN_NOTEBOOK = `"""Executing a submitted notebook inside a disposable container."""

from __future__ import annotations

import errno
import json
import math
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

# The earliest moment this program sees, taken before the heavy imports below:
# without the supervisor's mark (hold_export.py) it stands in for the moment
# the container started, from which the host counts the time limit.
STARTED = time.monotonic()

import nbformat  # noqa: E402
from nbclient import NotebookClient  # noqa: E402
from nbclient.exceptions import CellExecutionError, CellTimeoutError, DeadKernelError  # noqa: E402


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
# The whole run's limit, the one the host kills by; 0 means none was given. The
# host keeps the hard kill, and this lets the harness stop the notebook a little
# before it. A timer here holds where one inside the notebook would not: the
# cell runs in the kernel, a separate process, and this one only waits for its
# messages.
WALL = env_int("COMP_WALL_SECONDS", 0)
# How long before the host's deadline the notebook is stopped from inside: time
# to kill the kernel, write the executed copy and be seen finished — including
# the second a Pod's start time is rounded down by. A tenth of a short limit.
STOP_EARLY = 5.0

PROGRESS = RESULT / "progress.json"
RUN_JSON = RESULT / "run.json"
# What the participant opens on the submission page (storage.ts · EXECUTED_FILE).
EXECUTED = RESULT / "executed.ipynb"
# Run inside the kernel as it starts, not as a cell: a line a cell prints leaves
# the kernel before the cell goes on, so a kill for memory right after a print
# no longer takes the line with it (harness.ts · KERNEL_STREAMS).
KERNEL_STREAMS = Path(__file__).with_name("kernel_streams.py")


def run_started() -> float:
    """When the container started (the host counts the limit from then), on the monotonic clock both share."""
    try:
        mark = float(os.environ.get("COMP_STARTED_MONOTONIC") or "")
    except ValueError:
        return STARTED
    return mark if 0 < mark <= STARTED else STARTED


def stop_at() -> float | None:
    """The moment the notebook is stopped from inside; None when no limit was given."""
    if not WALL:
        return None
    return run_started() + WALL - min(STOP_EARLY, WALL / 10)


def merged_streams(nb):
    """A copy of the notebook for the file, with consecutive stream outputs of one stream joined.

    The kernel sends each of a cell's first lines on its own (kernel_streams.py),
    so that a line printed right before an out-of-memory kill is not lost in
    its buffer; that leaves one output entry per line. Jupyter shows them as
    one block anyway, and the file should read the same. The live notebook is
    left alone: nbclient keeps output indices for display updates.
    """
    flat = nbformat.from_dict(json.loads(json.dumps(nb)))
    for cell in flat.cells:
        outs = cell.get("outputs")
        if not outs:
            continue
        merged = []
        for out in outs:
            last = merged[-1] if merged else None
            if (out.get("output_type") == "stream" and last is not None
                    and last.get("output_type") == "stream" and last.get("name") == out.get("name")):
                parts = [last.get("text") or "", out.get("text") or ""]
                last["text"] = "".join("".join(p) if isinstance(p, list) else str(p) for p in parts)
                continue
            merged.append(out)
        cell["outputs"] = merged
    return flat


def save_executed(nb) -> None:
    """The executed notebook, whole or not at all: the host may copy it out at any moment."""
    tmp = EXECUTED.with_suffix(".tmp")
    try:
        with tmp.open("w", encoding="utf-8") as fh:
            nbformat.write(merged_streams(nb), fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, EXECUTED)
    except BaseException:
        # No half-written copy stays behind: the broker's exporter refuses a
        # result folder holding a file it does not know, and the run with it.
        tmp.unlink(missing_ok=True)
        raise


def forget_outputs(nb) -> None:
    """Clear what the notebook arrived with: its executed copy holds this run's outputs only."""
    for cell in nb.cells:
        if cell.get("cell_type") != "code":
            continue
        cell["outputs"] = []
        cell["execution_count"] = None
        metadata = cell.get("metadata")
        if isinstance(metadata, dict):
            metadata.pop("execution", None)


def write_json(path: Path, payload: dict) -> None:
    """A write that survives the container being killed a millisecond later."""
    payload["attemptId"] = os.environ.get("COMP_ATTEMPT_ID", "")
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


class OutOfTime(Exception):
    """The run's time came between two cells: the next one is not started."""


class Runner(NotebookClient):
    """NotebookClient with a beacon, an output cap, a watch over the answer and over the time."""

    def __init__(self, nb, stop_at=None, **kwargs):
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
        self.stop_at = stop_at
        # Every cell may wait only for what is left of the run: nbclient's own
        # timeout then stops the overrunning cell while this process can still
        # save what it printed.
        self.timeout_func = self.cell_budget
        self._saved_at = float("-inf")
        self._save_cost = 0.0

    def time_left(self) -> float | None:
        return None if self.stop_at is None else self.stop_at - time.monotonic()

    def cell_budget(self, cell=None):  # noqa: ARG002
        """The seconds one cell may take: what is left of the run, and never past the per-cell cap."""
        left = self.time_left()
        if left is None:
            return self.timeout
        # nbclient reads 0 as "no timeout at all", so a spent budget is one second.
        budget = max(1, math.ceil(left))
        return min(budget, self.timeout) if self.timeout else budget

    def snapshot(self, force: bool = False) -> None:
        """
        Put the notebook as far as it got on disk — at most once a second, and
        never more than a twentieth of the run, however big the notebook.

        The copy is for the day this process dies before its last line: the
        final write in main() replaces it with the whole story.
        """
        now = time.monotonic()
        if not force and now - self._saved_at < max(1.0, 20 * self._save_cost):
            return
        try:
            save_executed(self.nb)
        except Exception:  # noqa: BLE001
            # A copy that could not be written costs the salvage, not the run.
            return
        self._saved_at = time.monotonic()
        self._save_cost = self._saved_at - now

    async def _async_handle_timeout(self, timeout, cell=None):
        # The cell is stuck. The notebook goes on disk NOW, with what the cell
        # printed so far, before nbclient spends seconds on the kernel; and the
        # kernel is killed rather than asked to finish: a graceful shutdown of
        # a busy kernel waits five seconds, the whole of STOP_EARLY.
        self.snapshot(force=True)
        self.shutdown_kernel = "immediate"
        return await super()._async_handle_timeout(timeout, cell)

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
        left = self.time_left()
        if left is not None and left <= 0:
            raise OutOfTime("The run's time limit came between two cells")
        # Every cell before this one has finished: that much survives even a
        # death of this process.
        self.snapshot()
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


class PackagesDoNotFit(RuntimeError):
    """The set's environment ran out of room during the install; room is how much it had."""

    def __init__(self, detail: str, room: int | None):
        super().__init__(detail)
        self.room = room


def room_of(directory: Path) -> int | None:
    """The size of the filesystem a directory lives on: all the room the set was given."""
    try:
        stats = os.statvfs(directory)
    except OSError:
        return None
    return stats.f_blocks * stats.f_frsize


def dependency_command(args: list[str], room: Path | None = None) -> None:
    """Bound installation output on disk and retain only its useful tail."""
    with tempfile.TemporaryFile() as log:
        completed = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT)
        if completed.returncode:
            log.seek(0, os.SEEK_END)
            log.seek(max(0, log.tell() - 6000))
            detail = log.read().decode("utf-8", "replace")
            message = cell_error_detail(RuntimeError(detail)) or f"Installer exited with {completed.returncode}"
            # pip names a full disk in words ("[Errno 28] No space left on
            # device"), and that is the one install failure the participant can
            # act on: the set is too big for the room, not broken.
            if "No space left on device" in detail or "[Errno 28]" in detail:
                raise PackagesDoNotFit(message, room_of(room) if room is not None else None)
            raise RuntimeError(message)


def prepare_dependencies() -> str:
    """Install a published bundle offline and return its exact kernel name."""
    directory = os.environ.get("COMP_DEPENDENCIES")
    if not directory:
        return "python3"
    dependencies = Path(directory)
    # The set's own room, sized for it by the host and counted in the
    # submission's memory (runner-port.ts · RunRequest.packagesMb). Without
    # it the set shares the working folder's, as it used to — and a set of
    # 300 MB never fit into the 256 MB a 2 GB submission gives that folder.
    root = Path(os.environ.get("COMP_PACKAGES") or OUT)
    environment = root / ".colloq-venv"
    # Reuse base pip to avoid copying its wheels into every temporary venv.
    try:
        venv.EnvBuilder(system_site_packages=True, with_pip=False).create(environment)
    except OSError as exc:
        if exc.errno == errno.ENOSPC:
            raise PackagesDoNotFit(f"{type(exc).__name__}: {exc}", room_of(root)) from exc
        raise
    python = environment / "bin" / "python"
    dependency_command([
        sys.executable, "-I", "-m", "pip", "--isolated", "--disable-pip-version-check",
        "--python", str(python), "install", "--no-index", "--no-deps", "--no-cache-dir",
        "--no-compile", "--only-binary=:all:", "--require-hashes", "--find-links", str(dependencies / "wheels"),
        "-r", str(dependencies / "requirements.lock"),
    ], root)
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
        report = {
            "status": "dependency_error",
            "detail": cell_error_detail(exc),
            "cell": -1,
            "cells": 0,
            "wall": round(time.time() - started_wall, 3),
            "peakBytes": read_peak(),
        }
        if isinstance(exc, PackagesDoNotFit):
            # Named apart: "try again" is no answer to a set that cannot fit.
            report.update({"reason": "no_space", "roomBytes": exc.room})
        write_json(RUN_JSON, report)
        return 1

    forget_outputs(nb)
    runner = Runner(
        nb,
        stop_at=stop_at(),
        timeout=CELL_TIMEOUT,
        kernel_name=kernel_name,
        allow_errors=False,
        force_raise_errors=True,
        # The notebook's working folder is the writable /out: the participant
        # writes the answer with a relative path, as they are used to.
        resources={"metadata": {"path": str(OUT)}},
        # exec_files, not exec_lines: IPython runs exec_lines as a cell, and a
        # cell puts back the stream's own write when it ends.
        extra_arguments=[f"--IPKernelApp.exec_files={KERNEL_STREAMS}"],
    )
    runner.beat("start")

    try:
        runner.execute()
    except SystemExit as exc:
        status = "target_too_large" if exc.code == 90 else "exit"
        detail = runner.oversize or f"SystemExit({exc.code})"
    except (CellTimeoutError, OutOfTime) as exc:
        status = "cell_timeout"
        detail = (str(exc).splitlines() or [type(exc).__name__])[0][:400]
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
    # page: their code, their output, their traceback on the failed cell — and
    # on a timed-out or killed kernel, every cell that finished and what the
    # last one printed. The outputs in it are already trimmed by the cap, so
    # it can be written without fear of gigabytes.
    try:
        save_executed(nb)
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
 * What the submission's kernel runs as it starts: a line a cell prints leaves
 * the kernel before the cell goes on.
 *
 * Bought by a class: a cell printed "about to allocate over 2 GB", then did
 * `bytearray(2200 * 1024 * 1024)`, and the executed notebook showed that cell
 * with no output at all. ipykernel's stdout only buffers a write; the IOPub
 * thread sends it on a 0.2 s timer, and that thread needs the GIL. bytearray
 * zero-fills its two gigabytes inside one C call that holds the GIL until the
 * OOM killer ends the process, so the thread never ran again and the line died
 * in the kernel's buffer. Before a timeout the same line survived: a sleeping
 * cell lets the thread run.
 *
 * A shorter flush interval was measured and does not help: the timer cannot
 * fire without the GIL either (0 of 5 runs kept the line; it does help an
 * allocation that lets the GIL go, like numpy's). Nor does `flush()`: it
 * returns once the IOPub thread has built the message, and the send itself is
 * queued behind that. Flushing twice does it — the thread's queue is first in,
 * first out, so the second flush returns only after the first one's message
 * went out (5 of 5).
 *
 * A handover costs about 0.3 ms, which a loop of prints cannot pay on every
 * line (100 000 prints went from 0.2 s to 32 s). So a line goes at once while
 * the cell has sent fewer than twenty that way, and after that when 0.2 s — the
 * kernel's own flush interval — has passed since the last one; the rest waits
 * for the timer as before. With that budget the same 100 000 prints take
 * 0.26 s instead of 0.23 s, most of it the wrapper's own call. Only the
 * kernel's main thread in the kernel's own process hands over: threads and
 * forked children keep ipykernel's batching. A line sent at once is a stream
 * output of its own in the executed notebook; Jupyter and VS Code show
 * neighbouring ones as one block.
 *
 * Loaded through `IPKernelApp.exec_files`, not `exec_lines`: IPython runs
 * exec_lines as a cell, and every cell swaps the stream's `write` for a tee
 * and puts back the one it found when it ends — a wrapper installed inside a
 * cell is gone after it. A file is executed outside any cell, and it defines
 * nothing it leaves behind: the participant's namespace, cells and execution
 * numbers stay theirs. Anything unexpected in ipykernel leaves the kernel as
 * it was.
 */
const KERNEL_STREAMS = String.raw`# A line printed in a cell leaves the kernel before the cell goes on
# (harness.ts · KERNEL_STREAMS). A comment, not a docstring: this runs in the
# participant's namespace, and a docstring would become their __doc__.


def _colloq_lines_at_once():
    import sys
    # Bound once: a notebook that mocks time.monotonic or os.getpid for its own
    # tests must not change what happens to its output.
    from os import getpid
    from threading import current_thread, main_thread
    from time import monotonic

    from IPython import get_ipython
    from ipykernel.iostream import OutStream

    per_cell = 20
    every = 0.2
    sent = {"lines": 0, "at": float("-inf")}
    main = main_thread()
    pid = getpid()

    def new_cell(*_):
        sent["lines"] = 0

    def at_once(stream):
        write = stream.write

        def write_at_once(text, *args, **kwargs):
            written = write(text, *args, **kwargs)
            if "\n" not in text:
                return written
            # The cheap test first: in a loop of prints nearly every line
            # stops here, and costs well under a microsecond.
            now = monotonic()
            if sent["lines"] >= per_cell and now - sent["at"] < every:
                return written
            if current_thread() is main and getpid() == pid:
                sent["lines"] += 1
                sent["at"] = now
                # The first hands the text to the IOPub thread, the second
                # returns once that thread has sent it.
                stream.flush()
                stream.flush()
            return written

        stream.write = write_at_once

    get_ipython().events.register("pre_run_cell", new_cell)
    for stream in (sys.stdout, sys.stderr):
        if isinstance(stream, OutStream):
            at_once(stream)


try:
    _colloq_lines_at_once()
except Exception:  # noqa: BLE001
    pass
del _colloq_lines_at_once
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
import re
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
# The name pandas gives a column whose header is empty: "Unnamed: 0" is the
# index to_csv() writes unless told index=False, and ".1" follows when the
# name is taken already — a file read with its index and written back with
# another one.
UNNAMED = re.compile(r"Unnamed: \\d+(?:\\.\\d+)?")
# A number with a decimal comma: what to_csv(decimal=",") writes, and what a
# spreadsheet saves in a locale that uses one.
DECIMAL_COMMA = re.compile(r"[+-]?(?:\\d+,\\d*|,\\d+)(?:[eE][+-]?\\d+)?")
# An id that is a whole number, perhaps written as a float: "007", "7", "7.0".
WHOLE_NUMBER = re.compile(r"\\d+(?:\\.0*)?")
# A whole number written the one plain way: what a key of numeric ids holds.
PLAIN_WHOLE = re.compile(r"-?(?:0|[1-9]\\d*)")
# A whole number in any spelling a notebook produces: "+7", "007", "7.0".
SPELLED_WHOLE = re.compile(r"[+-]?\\d+(?:\\.0*)?")


def whole_spelling(value):
    """A whole number's other spellings brought to the plain one; any other id as it was."""
    text = str(value).strip()
    return str(int(text.split(".")[0])) if SPELLED_WHOLE.fullmatch(text) else value


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


def shown(value, limit: int = 60) -> str:
    """
    A value quoted back to the participant: plain, and cut short visibly
    rather than silently.

    A refusal that quotes one is dumped with ensure_ascii off: participant_failure
    keeps the first 1000 characters, and escaped, a Cyrillic value spends six of
    them on every letter.
    """
    text = str(plain(value))
    return text if len(text) <= limit else text[: limit - 1] + "…"


def id_form(value) -> str:
    """
    An id without what notebooks tend to change in one: case, hyphens, the
    spaces around it, and in a whole number the leading zeros and a float's
    ".0".
    """
    text = str(value).strip().lower().replace("-", "")
    if WHOLE_NUMBER.fullmatch(text):
        text = text.split(".")[0].lstrip("0") or "0"
    return text


def blank(values: pd.Series) -> pd.Series:
    """
    NaN, None and text that is empty once stripped: a cell without a value.

    Text is checked value by value rather than through the str accessor: the
    same line then reads a text column the way pandas 2 gives it (object, with
    whatever else lies in it) and the way pandas 3 does (str), and read_csv
    leaves "   " as text in both.
    """
    empty = values.isna()
    if not pd.api.types.is_numeric_dtype(values.dtype):
        empty = empty | values.map(lambda value: isinstance(value, str) and not value.strip()).astype(bool)
    return empty


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
    # The DataFrame's own index, which to_csv() writes as a first column with
    # an empty header unless told index=False. Left to the teacher's score(),
    # it reads as "name the columns id, target in this order", and nothing in
    # that points at the index. A column the answer key has itself is left
    # alone: then it is part of the answer the key expects back.
    unnamed = [
        column
        for column in submission.columns
        if column not in solution.columns and (UNNAMED.fullmatch(str(column)) or not str(column).strip())
    ]
    if unnamed:
        raise ParticipantVisibleError(
            json.dumps(
                {"code": "indexColumn", "params": {"column": shown(unnamed[0]), "file": SUBMISSION.name}},
                ensure_ascii=False,
            )
        )
    # A key of plain whole numbers keeps the leniency it always had: pandas
    # used to read both files' ids as numbers, so 100002.0 or 0100002 in an
    # answer matched 100002 in the key, and a notebook whose ids went through
    # a float must not start failing now. Ids are read as text all the same
    # (a UUID or "007" must never become a number), and every other key is
    # compared exactly as written.
    if len(solution) and solution[ID_COLUMN].map(lambda value: bool(PLAIN_WHOLE.fullmatch(str(value)))).all():
        submission = submission.copy()
        submission[ID_COLUMN] = submission[ID_COLUMN].map(whole_spelling)
    if submission[ID_COLUMN].duplicated().any():
        dup = submission.loc[submission[ID_COLUMN].duplicated(), ID_COLUMN].iloc[0]
        raise ParticipantVisibleError(
            json.dumps({"code": "duplicateId", "params": {"column": ID_COLUMN, "example": str(plain(dup))}})
        )
    indexed = submission.set_index(ID_COLUMN)
    want = solution[ID_COLUMN]
    missing = want[~want.isin(indexed.index)]
    if len(missing):
        # The rows may be there with their ids in another form: upper-cased,
        # stripped of hyphens, or read in as numbers and written back as 7 or
        # 7.0 for "007". Named as missing, they send the participant looking
        # for rows they have; one id next to the same id as the test writes it
        # shows what to change. Only when that form explains at least half of
        # what is missing: below that the rows are missing indeed, and the
        # count says more than an example.
        forms: dict[str, str] = {}
        for sent in indexed.index[~indexed.index.isin(want)]:
            forms.setdefault(id_form(sent), sent)
        found, pair = 0, None
        for expected in missing:
            sent = forms.get(id_form(expected))
            if sent is None:
                continue
            found += 1
            if pair is None:
                pair = (sent, expected)
        if pair is not None and 2 * found >= len(missing):
            raise ParticipantVisibleError(
                json.dumps(
                    {
                        "code": "idForm",
                        "params": {"column": ID_COLUMN, "example": shown(pair[0]), "expected": shown(pair[1])},
                    },
                    ensure_ascii=False,
                )
            )
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
    aligned = indexed.loc[want].reset_index()
    # Every row is there, but some carry no prediction. Left to the teacher's
    # score(), that reads as "not every row has a prediction" at best, with no
    # count and no row, and as a crash of the metric at worst. Only the columns
    # the answer key also has are predictions, and only where the key has a
    # value: a blank the key shares is a gap in the teacher's answers, not a
    # forgotten prediction, and no participant can be refused for it.
    for column in aligned.columns:
        if column in (ID_COLUMN, USAGE_COLUMN) or column not in solution.columns:
            continue
        empty = blank(aligned[column]).to_numpy() & ~blank(solution[column]).to_numpy()
        if empty.any():
            raise ParticipantVisibleError(
                json.dumps(
                    {
                        "code": "emptyPredictions",
                        "params": {
                            "count": int(empty.sum()),
                            # Capped: participant_failure keeps the first 1000
                            # characters, and a cut json would reach the
                            # participant as raw braces.
                            "column": str(column)[:100],
                            "idColumn": ID_COLUMN,
                            "example": str(plain(aligned[ID_COLUMN].to_numpy()[empty][0]))[:100],
                        },
                    }
                )
            )
        # Infinity where the answer key holds numbers: it parses as a number,
        # so the text check below lets it through, and a metric such as
        # roc_auc_score then crashes on it with nothing for the participant.
        key = solution[column].dtype
        if pd.api.types.is_numeric_dtype(key) and not pd.api.types.is_bool_dtype(key):
            infinite = (pd.to_numeric(aligned[column], errors="coerce").abs() == float("inf")).to_numpy()
            if infinite.any():
                raise ParticipantVisibleError(
                    json.dumps(
                        {
                            "code": "infinitePredictions",
                            "params": {
                                "count": int(infinite.sum()),
                                "column": str(column)[:100],
                                "idColumn": ID_COLUMN,
                                "example": shown(aligned[ID_COLUMN].to_numpy()[infinite][0]),
                            },
                        },
                        ensure_ascii=False,
                    )
                )
        # Text where the answer key holds numbers. A notebook that wrote its
        # answer with to_csv(decimal=",") sends "0,4478" for 0.4478, and the
        # metric's float() crashes on it: the teacher gets a traceback, the
        # participant not a word. Only a key of numbers asks for them (pandas
        # counts true/false as numbers too, a key of them does not), and a
        # blank is not text: it stays the refusal above's.
        key = solution[column].dtype
        if (
            not pd.api.types.is_numeric_dtype(key)
            or pd.api.types.is_bool_dtype(key)
            or pd.api.types.is_numeric_dtype(aligned[column].dtype)
        ):
            continue
        values = aligned[column]
        wrong = (pd.to_numeric(values, errors="coerce").isna() & ~blank(values)).to_numpy()
        if wrong.any():
            rows = wrong.nonzero()[0]
            texts = values.to_numpy()
            # A decimal comma is looked for among all of them, not only in the
            # first: it is the likelier fix, and naming the separator next to
            # an example without a comma would read as nonsense.
            comma = next((row for row in rows if DECIMAL_COMMA.fullmatch(str(texts[row]).strip())), None)
            row = rows[0] if comma is None else comma
            raise ParticipantVisibleError(
                json.dumps(
                    {
                        "code": "nonNumeric" if comma is None else "decimalComma",
                        "params": {
                            "column": str(column)[:100],
                            "value": shown(texts[row]),
                            "idColumn": ID_COLUMN,
                            "example": shown(aligned[ID_COLUMN].to_numpy()[row]),
                        },
                    },
                    ensure_ascii=False,
                )
            )
    return aligned


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
    # The ids are read as the text they are, in both files. Left to pandas,
    # "001" became 1, and one stray value turned the answer's column into text
    # while the key's stayed numbers, so that not a single row matched. A
    # converter rather than dtype=str: it also keeps an id such as "NA" from
    # turning into a missing value.
    ids_as_text = {ID_COLUMN: str}
    try:
        solution = pd.read_csv(SOLUTION, converters=ids_as_text)
        if ID_COLUMN not in solution.columns:
            raise RuntimeError(f"solution.csv has no column {ID_COLUMN!r}")
        try:
            submission = pd.read_csv(SUBMISSION, converters=ids_as_text)
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
//
// The supervisor still has a deadline of its own: the wall limit plus two
// minutes, after which it kills the notebook and exits non-zero, stopping the
// container. The host kills long before that; the deadline is for the day the
// host is gone — a server that died mid-run leaves a container nobody
// watches, and it kept its memory and CPUs until the next start swept it, or
// forever if that start did not come. The stopped remains are still swept.
//
// It also hands the notebook harness the moment the container started, on the
// monotonic clock both share: the harness stops an overrunning notebook a few
// seconds before the host's deadline (run_notebook.py · stop_at), and the
// host counts that deadline from the container's start, not the harness's.
const HOLD_EXPORT = `import json, os, subprocess, sys, time
from pathlib import Path

def seconds(name, default):
    try:
        value = int((os.environ.get(name) or "").strip())
    except ValueError:
        return default
    return value if value >= 0 else default

directory = Path(sys.argv[1])
directory.mkdir(parents=True, exist_ok=True)
started = time.monotonic()
os.environ["COMP_STARTED_MONOTONIC"] = repr(started)
deadline = started + seconds("COMP_WALL_SECONDS", 14400) + seconds("COMP_ORPHAN_GRACE_SECONDS", 120)
child = subprocess.Popen([sys.executable, sys.argv[2]])
try:
    code = child.wait(timeout=max(0.1, deadline - time.monotonic()))
except subprocess.TimeoutExpired:
    child.kill()
    sys.exit(124)
temporary = directory / ".complete-next"
temporary.write_text(json.dumps({"attemptId": os.environ["COMP_ATTEMPT_ID"], "exit": code}))
os.replace(temporary, directory / ".complete.json")
while time.monotonic() < deadline:
    time.sleep(min(60, max(0.1, deadline - time.monotonic())))
sys.exit(125)
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
  ['kernel_streams.py', KERNEL_STREAMS],
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
