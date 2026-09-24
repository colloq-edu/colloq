#!/usr/bin/env python3
"""
Seminar activity into a Google Sheet, one row per participant.

    python3 scripts/activity-sheet.py y84w9hpc              # append the room
    python3 scripts/activity-sheet.py y84w9hpc --replace    # recount: replace the room's rows
    python3 scripts/activity-sheet.py --all                 # every room with activity not yet in the sheet
    python3 scripts/activity-sheet.py y84w9hpc --dry        # only show, write nothing
    python3 scripts/activity-sheet.py --create "Colloq · activity"   # create the spreadsheet

Where to write: ACTIVITY_SHEET_ID from .env (or the environment), or --sheet <id>.
Where to read: data/colloq.db nearby (the same database as for `make run`), or --db.
Google is reached through `gws` (the Google Workspace CLI, already authorized: `gws auth status`).

The "Семинары" (seminars) sheet accumulates: one row per person per seminar, keyed
by the "Комната" (room) and "Участник" (participant) columns; a room that is
already there is not appended a second time. The "Сводка" (summary) sheet is a
single QUERY formula over "Семинары"; it computes itself and, as rows are added,
shows the total for each participant: that is what the activity grade is later
built from.

What is counted per person (all their sockets and devices under one name):
  minutes in the room: the union of presence intervals (two tabs are not double
  time); notebook edits: the versions they contributed; cell runs: total /
  successful / with an error / cancelled, and the compute seconds of the
  successful ones; questions to the Oracle; answers in the Council and how many
  of them are correct.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHEET_ROWS = "Семинары"
SHEET_SUMMARY = "Сводка"
HEADER = [
    "Дата",
    "Семинар",
    "Комната",
    "Участник",
    "Роль",
    "Входов",
    "Первый вход",
    "Последний выход",
    "Минут в комнате",
    "Правок в тетради",
    "Запусков",
    "Успешных",
    "С ошибкой",
    "Отменённых",
    "Секунд счёта",
    "Вопросов оракулу",
    "Ответов в консилиуме",
    "Верных в консилиуме",
]
LAST_COL = chr(ord("A") + len(HEADER) - 1)  # R
# The argument separator is ";": the spreadsheet is created with the Russian locale (see create).
SUMMARY_FORMULA = (
    f"=QUERY({SHEET_ROWS}!A:{LAST_COL}; "
    '"select D, count(C), sum(I), sum(J), sum(K), sum(L), sum(M), sum(P), sum(Q), sum(R) '
    "where E = 'participant' group by D order by D "
    "label D 'Участник', count(C) 'Семинаров', sum(I) 'Минут', sum(J) 'Правок', "
    "sum(K) 'Запусков', sum(L) 'Успешных', sum(M) 'С ошибкой', sum(P) 'Вопросов оракулу', "
    "sum(Q) 'Консилиум', sum(R) 'Верных'\"; 1)"
)


def die(msg: str) -> None:
    print(msg, file=sys.stderr)
    sys.exit(1)


# ----------------------------------------------------------------- .env

def dotenv(name: str) -> str | None:
    if os.environ.get(name):
        return os.environ[name]
    env = ROOT / ".env"
    if not env.exists():
        return None
    for line in env.read_text().splitlines():
        line = line.strip()
        if line.startswith(f"{name}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'") or None
    return None


# ----------------------------------------------------------------- database

def opendb(path: Path) -> sqlite3.Connection:
    if not path.exists():
        die(f"no database: {path}")
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    return con


def rooms_with_activity(con: sqlite3.Connection) -> list[str]:
    rows = con.execute(
        """SELECT s.id FROM sessions s
           WHERE EXISTS (SELECT 1 FROM session_activity a WHERE a.session_id = s.id)
           ORDER BY s.created_at"""
    ).fetchall()
    return [r["id"] for r in rows]


def union_minutes(intervals: list[tuple[int, int]]) -> float:
    total = 0
    cur_s = cur_e = None
    for s, e in sorted(intervals):
        if e <= s:
            continue
        if cur_e is None or s > cur_e:
            if cur_e is not None:
                total += cur_e - cur_s
            cur_s, cur_e = s, e
        else:
            cur_e = max(cur_e, e)
    if cur_e is not None:
        total += cur_e - cur_s
    return round(total / 60000, 1)


def local(ms: int | None, fmt: str) -> str:
    return datetime.fromtimestamp(ms / 1000).strftime(fmt) if ms else ""


def room_rows(con: sqlite3.Connection, room: str) -> list[list]:
    session = con.execute("SELECT * FROM sessions WHERE id = ?", (room,)).fetchone()
    if session is None:
        die(f"room {room} is not in the database")
    people = con.execute(
        "SELECT id, name, role, last_seen FROM participants WHERE session_id = ?", (room,)
    ).fetchall()
    by_id = {p["id"]: p for p in people}
    events = con.execute(
        """SELECT created_at, kind, actor_id, actor_name, actor_role, details
           FROM session_activity WHERE session_id = ? ORDER BY seq""",
        (room,),
    ).fetchall()

    def name_of(actor_id: str | None, fallback: str | None) -> str | None:
        p = by_id.get(actor_id or "")
        return p["name"] if p else fallback

    # Everything by name: one person can have several ids (a phone and a
    # laptop, a second tab after the browser was cleared).
    stat: dict[str, dict] = defaultdict(
        lambda: {
            "roles": set(),
            "ids": set(),
            "joins": 0,
            "first": None,
            "last": None,
            "intervals": [],
            "edits": 0,
            "runs": defaultdict(int),
            "run_ms": 0,
            "oracle": 0,
            "council": 0,
            "council_ok": 0,
        }
    )
    for p in people:
        s = stat[p["name"]]
        s["roles"].add(p["role"])
        s["ids"].add(p["id"])

    open_joins: dict[str, list[int]] = defaultdict(list)
    for e in events:
        name = name_of(e["actor_id"], e["actor_name"])
        if not name:
            continue
        s = stat[name]
        if e["actor_role"]:
            s["roles"].add(e["actor_role"])
        d = json.loads(e["details"] or "{}")
        kind = e["kind"]
        at = e["created_at"]
        if kind == "presence.joined":
            s["joins"] += 1
            s["first"] = at if s["first"] is None else min(s["first"], at)
            open_joins[e["actor_id"]].append(at)
        elif kind == "presence.left":
            dur = int(d.get("durationMs") or 0)
            s["intervals"].append((at - dur, at))
            s["last"] = at if s["last"] is None else max(s["last"], at)
            if open_joins[e["actor_id"]]:
                open_joins[e["actor_id"]].pop()
        elif kind == "notebook.contributed":
            s["edits"] += int(d.get("count") or 1)
        elif kind == "execution.finished":
            outcome = d.get("outcome") or "completed"
            s["runs"][outcome] += 1
            if outcome == "completed":
                s["run_ms"] += int(d.get("durationMs") or 0)
        elif kind == "oracle.asked":
            s["oracle"] += 1
    # A join without a leave: the person is still in the room, or the socket
    # went away without a goodbye; count up to the last time the server saw them.
    for actor_id, joins in open_joins.items():
        p = by_id.get(actor_id)
        if not p:
            continue
        s = stat[p["name"]]
        for at in joins:
            s["intervals"].append((at, p["last_seen"]))
            s["last"] = p["last_seen"] if s["last"] is None else max(s["last"], p["last_seen"])

    for row in con.execute(
        """SELECT participant_id, submitted_at, correct FROM council_attempts
           WHERE session_id = ? AND submitted_at IS NOT NULL""",
        (room,),
    ):
        p = by_id.get(row["participant_id"])
        if not p:
            continue
        stat[p["name"]]["council"] += 1
        if row["correct"]:
            stat[p["name"]]["council_ok"] += 1

    date = local(session["created_at"], "%Y-%m-%d")
    out = []
    for name, s in stat.items():
        role = "host" if "host" in s["roles"] else "participant"
        runs = s["runs"]
        out.append(
            [
                date,
                session["name"],
                room,
                name,
                role,
                s["joins"],
                local(s["first"], "%H:%M"),
                local(s["last"], "%H:%M"),
                union_minutes(s["intervals"]),
                s["edits"],
                sum(runs.values()),
                runs["completed"],
                runs["error"],
                runs["cancelled"],
                round(s["run_ms"] / 1000, 1),
                s["oracle"],
                s["council"],
                s["council_ok"],
            ]
        )
    # Students alphabetically, the teacher at the end.
    out.sort(key=lambda r: (r[4] == "host", r[3].lower()))
    return out


# ----------------------------------------------------------------- gws

def gws(*args: str, body: dict | None = None, params: dict | None = None) -> dict:
    cmd = ["gws", *args]
    if params is not None:
        cmd += ["--params", json.dumps(params, ensure_ascii=False)]
    if body is not None:
        cmd += ["--json", json.dumps(body, ensure_ascii=False)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        die(f"gws {' '.join(args)} failed:\n{proc.stderr.strip()}\n{proc.stdout.strip()}")
    text = proc.stdout.strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Service lines before the JSON ("Using keyring backend…") turn up in stdout too.
        start = text.find("{")
        return json.loads(text[start:]) if start >= 0 else {}


def create_spreadsheet(title: str) -> str:
    created = gws(
        "sheets", "spreadsheets", "create",
        body={
            "properties": {"title": title, "locale": "ru_RU"},
            "sheets": [
                {"properties": {"title": SHEET_ROWS, "gridProperties": {"frozenRowCount": 1}}},
                {"properties": {"title": SHEET_SUMMARY, "gridProperties": {"frozenRowCount": 1}}},
            ],
        },
    )
    sid = created["spreadsheetId"]
    rows_sheet_id = created["sheets"][0]["properties"]["sheetId"]
    summary_sheet_id = created["sheets"][1]["properties"]["sheetId"]
    gws(
        "sheets", "spreadsheets", "values", "update",
        params={"spreadsheetId": sid, "range": f"{SHEET_ROWS}!A1", "valueInputOption": "RAW"},
        body={"values": [HEADER]},
    )
    gws(
        "sheets", "spreadsheets", "values", "update",
        params={"spreadsheetId": sid, "range": f"{SHEET_SUMMARY}!A1", "valueInputOption": "USER_ENTERED"},
        body={"values": [[SUMMARY_FORMULA]]},
    )
    bold = {
        "repeatCell": {
            "range": {"sheetId": None, "startRowIndex": 0, "endRowIndex": 1},
            "cell": {"userEnteredFormat": {"textFormat": {"bold": True}}},
            "fields": "userEnteredFormat.textFormat.bold",
        }
    }
    requests = []
    for sheet_id in (rows_sheet_id, summary_sheet_id):
        req = json.loads(json.dumps(bold))
        req["repeatCell"]["range"]["sheetId"] = sheet_id
        requests.append(req)
        requests.append(
            {"autoResizeDimensions": {"dimensions": {"sheetId": sheet_id, "dimension": "COLUMNS"}}}
        )
    gws("sheets", "spreadsheets", "batchUpdate", params={"spreadsheetId": sid}, body={"requests": requests})
    return sid


def existing_rows(sid: str) -> list[list]:
    got = gws(
        "sheets", "spreadsheets", "values", "get",
        params={"spreadsheetId": sid, "range": f"{SHEET_ROWS}!A2:{LAST_COL}"},
    )
    return got.get("values", [])


def append_rows(sid: str, rows: list[list]) -> None:
    gws(
        "sheets", "spreadsheets", "values", "append",
        params={
            "spreadsheetId": sid,
            "range": f"{SHEET_ROWS}!A1:{LAST_COL}",
            "valueInputOption": "RAW",
            "insertDataOption": "INSERT_ROWS",
        },
        body={"values": rows},
    )


def rewrite_rows(sid: str, rows: list[list]) -> None:
    gws(
        "sheets", "spreadsheets", "values", "clear",
        params={"spreadsheetId": sid, "range": f"{SHEET_ROWS}!A2:{LAST_COL}"},
        body={},
    )
    if rows:
        gws(
            "sheets", "spreadsheets", "values", "update",
            params={"spreadsheetId": sid, "range": f"{SHEET_ROWS}!A2", "valueInputOption": "RAW"},
            body={"values": rows},
        )


# ----------------------------------------------------------------- main

def show(rows: list[list]) -> None:
    widths = [max(len(str(r[i])) for r in [HEADER, *rows]) for i in range(len(HEADER))]
    for r in [HEADER, *rows]:
        print("  ".join(str(v).ljust(widths[i]) for i, v in enumerate(r)).rstrip())


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("rooms", nargs="*", help="room ids (the tail of the /s/<id> link)")
    ap.add_argument("--all", action="store_true", help="every room with activity that is not in the sheet yet")
    ap.add_argument("--replace", action="store_true", help="replace these rooms' rows in the sheet")
    ap.add_argument("--dry", action="store_true", help="show and write nothing")
    ap.add_argument("--create", metavar="TITLE", help="create a new spreadsheet with this title")
    ap.add_argument("--sheet", help="spreadsheet id (ACTIVITY_SHEET_ID from .env by default)")
    ap.add_argument("--db", default=str(ROOT / "data" / "colloq.db"))
    a = ap.parse_args()

    con = opendb(Path(a.db))
    rooms = list(a.rooms)
    if a.all:
        rooms += [r for r in rooms_with_activity(con) if r not in rooms]
    if not rooms and not a.create:
        ap.error("name a room, --all or --create")

    computed = {room: room_rows(con, room) for room in rooms}
    if a.dry:
        for room, rows in computed.items():
            print(f"— {room}: {len(rows)} rows")
            show(rows)
        return

    sid = a.sheet or dotenv("ACTIVITY_SHEET_ID")
    if a.create:
        sid = create_spreadsheet(a.create)
        print(f"spreadsheet created: https://docs.google.com/spreadsheets/d/{sid}")
        print(f"into .env: ACTIVITY_SHEET_ID={sid}")
    if not sid:
        die('nowhere to write to: ACTIVITY_SHEET_ID in .env, --sheet <id> or --create "title"')

    have = existing_rows(sid)
    present = {r[2] for r in have if len(r) > 2}
    if a.replace:
        kept = [r for r in have if len(r) <= 2 or r[2] not in computed]
        fresh = [row for room in rooms for row in computed[room]]
        rewrite_rows(sid, kept + fresh)
        for room in rooms:
            print(f"{room}: {len(computed[room])} rows written anew")
    else:
        for room in rooms:
            if room in present:
                print(f"{room}: already in the sheet, skipping (to recount: --replace)")
                continue
            append_rows(sid, computed[room])
            print(f"{room}: {len(computed[room])} rows appended")
    print(f"https://docs.google.com/spreadsheets/d/{sid}")


if __name__ == "__main__":
    main()
