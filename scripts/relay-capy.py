#!/usr/bin/env python3
"""Таблица рекордов для игры на странице ожидания ретранслятора.

Страница «комната ещё не открыта» (scripts/relay-offline.html) занимает
студента пиксельной капибарой, пока преподаватель не открыл комнату, и
предлагает вписать очки в общую таблицу. Таблица — это и есть весь сервис:
одна JSON-коллекция на диске и два запроса.

    GET  /.relay/capy/scores   → {"top": [{"id", "name", "score"}...],
                                  "total": попыток, "names": разных имён}
    POST /.relay/capy/scores   ← {"name": "...", "score": 123}
                               → {"id", "name", "rank", "best", "improved",
                                  "total", "names", "top": [...]}
                                 id, name и best — строки этого имени в таблице
                                 (лучшей попытки); rank: null — очков не
                                 хватило даже на хвост хранилища.

Живёт на петле (127.0.0.1:9181) за caddy: тот отдаёт ему путь /.relay/capy/*
для любого имени под *.colloq.ru — путь начинается с точки, чтобы не пересечься
ни с одним адресом инстанса. Ставится и обновляется scripts/relay-setup.sh как
systemd-служба colloq-capy от отдельного пользователя; данные в
/var/lib/colloq-capy/scores.json.

Почему стандартная библиотека, а не что-то удобнее: на ретрансляторе нет ни
node, ни pip, ни желания их туда тащить — это машина с двумя демонами и
секретом, и каждая лишняя зависимость на ней лишняя. python3 в Ubuntu есть
всегда.

Таблица — одна строка на имя: лучший результат человека, а не все его попытки
подряд (иначе первые десять мест занимает один упорный студент). Имена
сравниваются без учёта регистра. Исключение — «Аноним»: безымянные попытки
живут каждая своей строкой, иначе все студенты без имени делили бы один
результат и один ответ «ваш лучший». Попытки считаются все — это число над
таблицей.

Что здесь проверяется: имя — до 16 знаков, без управляющих и невидимых
символов, хотя бы с одним видимым, пустое становится «Аноним»; очки — целое от
0 до 99 999 (игра честно набирает около десяти в секунду, больше — не игра).
Лимит на адрес — корзина: пять записей сразу, дальше по одной в три секунды.
Это не защита от умельца с curl, а защита от нажатого и забытого F5 — и при
этом целый класс за одним NAT в неё помещается. Адрес берётся из ПОСЛЕДНЕГО
элемента X-Forwarded-For: его дописывает caddy, первый присылает клиент, и
верить ему нельзя. Таблица хранит пятьсот лучших; остальное отсеивается при
записи, и ответ считается по тому, что сохранено, а не по тому, что пришло.

Проверка руками, без ретранслятора:
    CAPY_STATE=/tmp/capy CAPY_PORT=9181 CAPY_PAGE=scripts/relay-offline.html \
        python3 scripts/relay-capy.py
и открыть http://127.0.0.1:9181/ — с CAPY_PAGE сервис отдаёт страницу на любой
путь, чтобы игру и таблицу можно было погонять с одного адреса.
"""

import json
import os
import re
import sys
import tempfile
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE_DIR = os.environ.get("CAPY_STATE", "/var/lib/colloq-capy")
STORE = os.path.join(STATE_DIR, "scores.json")
PORT = int(os.environ.get("CAPY_PORT", "9181"))
PAGE = os.environ.get("CAPY_PAGE")  # только для проверки руками

PATH = "/.relay/capy/scores"
KEEP = 500
TOP = 10
NAME_MAX = 16
SCORE_MAX = 99_999
BODY_MAX = 2048
ANON = "Аноним"
# Корзина на адрес: BURST записей сразу, дальше одна в REFILL_SECONDS.
BURST = 5
REFILL_SECONDS = 3.0

_lock = threading.Lock()
_buckets = {}  # адрес → (токенов, когда считали)


def load():
    try:
        with open(STORE, encoding="utf-8") as f:
            rows = json.load(f)
    except (OSError, ValueError):
        return []
    if not isinstance(rows, list):
        return []
    # Форму строк не принимать на веру: файл правят руками на машине, и схема
    # может поменяться в следующей версии — мусорная строка должна исчезнуть
    # из таблицы, а не убить оба запроса KeyError'ом навсегда.
    return [
        r for r in rows
        if isinstance(r, dict)
        and isinstance(r.get("id"), str)
        and isinstance(r.get("name"), str)
        and isinstance(r.get("score"), int) and not isinstance(r.get("score"), bool)
        and isinstance(r.get("at"), (int, float)) and not isinstance(r.get("at"), bool)
    ]


def save(rows):
    # Через временный файл и переименование: обрыв на середине записи не
    # оставит полупустой JSON, из которого потом не прочитается ничего.
    os.makedirs(STATE_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=STATE_DIR, prefix=".scores-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False)
        os.replace(tmp, STORE)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def ordered(rows):
    # Больше очков — выше; при равенстве раньше записанный выше.
    return sorted(rows, key=lambda r: (-r["score"], r["at"]))


def key_of(row):
    # Ключ склейки: имя без регистра; анонимы — каждый сам по себе.
    return row["name"].casefold() if row["name"] != ANON else "\0" + row["id"]


def board(rows):
    # Упорядоченные строки без повторов имени: первая встреча — лучшая.
    seen = set()
    out = []
    for r in ordered(rows):
        k = key_of(r)
        if k in seen:
            continue
        seen.add(k)
        out.append(r)
    return out


def public(row):
    return {"id": row["id"], "name": row["name"], "score": row["score"]}


def summary(rows):
    # Сколько всего попыток и сколько разных имён — для строки над таблицей.
    # Считается по хранимым пятистам: точнее и не нужно.
    return {"total": len(rows), "names": len({key_of(r) for r in rows})}


# Управляющие и невидимые: нулевой ширины, направление письма, изоляты,
# соединители, филлеры хангыля, BOM — всё, чем можно сделать имя пустым на
# вид или перевернуть соседей в таблице.
_CONTROL = re.compile(
    "[\x00-\x1f\x7f-\x9f­؜᠎​-‏ -‮"
    "⁠-⁤⁪-⁯ㅤ︀-️﻿ᅟᅠ]"
)


def clean_name(value):
    if not isinstance(value, str):
        return ANON
    value = _CONTROL.sub("", value)
    value = " ".join(value.split())[:NAME_MAX].strip()
    # Хотя бы один видимый знак — буква, цифра, знак препинания или символ.
    # Всё новое невидимое из будущих версий Unicode отсекается категорией,
    # а не списком выше.
    if not any(unicodedata.category(c)[0] in "LNPS" for c in value):
        return ANON
    return value


def clean_score(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value or value < 0 or value > SCORE_MAX:
        return None
    return int(value)


def allow(ip, now):
    # Корзина с запасом: класс, разбившийся по звонку разом, проходит; поток
    # из curl всё равно упирается в одну запись за три секунды.
    tokens, at = _buckets.get(ip, (BURST, now))
    tokens = min(BURST, tokens + (now - at) / REFILL_SECONDS)
    if tokens < 1:
        _buckets[ip] = (tokens, now)
        return False
    _buckets[ip] = (tokens - 1, now)
    if len(_buckets) > 10_000:
        # Не держать в памяти каждого, кто когда-либо заходил.
        for k in [k for k, (t, a) in _buckets.items() if now - a > BURST * REFILL_SECONDS]:
            del _buckets[k]
    return True


class Handler(BaseHTTPRequestHandler):
    server_version = "colloq-capy/2"
    protocol_version = "HTTP/1.1"
    # Недосказанное тело не должно держать поток вечно.
    timeout = 15

    def handle(self):
        # Студент закрыл вкладку посреди ответа — это не событие для журнала.
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    def log_message(self, fmt, *args):
        # В журнал systemd — только отказы; каждый GET таблицы туда не нужен.
        code = str(args[1]) if len(args) > 1 else ""
        if code[:1] in ("4", "5"):
            sys.stderr.write("%s - %s\n" % (self.client_ip(), fmt % args))

    def log_error(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.client_ip(), fmt % args))

    def client_ip(self):
        fwd = self.headers.get("X-Forwarded-For", "") if getattr(self, "headers", None) else ""
        # Последний элемент дописал caddy; первый прислал клиент, и он может
        # быть каким угодно.
        last = fwd.split(",")[-1].strip() if fwd else ""
        return last or (self.client_address[0] if self.client_address else "") or "?"

    def reply(self, code, body, ctype="application/json; charset=utf-8"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == PATH:
            with _lock:
                rows = load()
            return self.reply(200, {"top": [public(r) for r in board(rows)[:TOP]], **summary(rows)})
        if PAGE and self.command == "GET":
            try:
                with open(PAGE, "rb") as f:
                    return self.reply(404, f.read(), "text/html; charset=utf-8")
            except OSError:
                pass
        self.reply(404, {"error": "not found"})

    do_HEAD = do_GET

    def refuse(self, code, body):
        # Тело запроса не прочитано — остаток лёг бы в сокет и разобрался как
        # следующий запрос. Соединение закрывается, keep-alive тут не нужен.
        self.close_connection = True
        self.reply(code, body)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path != PATH:
            return self.refuse(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length < 0 or length > BODY_MAX:
            return self.refuse(413, {"error": "body too large"})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, UnicodeDecodeError):
            return self.reply(400, {"error": "bad json"})
        if not isinstance(body, dict):
            return self.reply(400, {"error": "bad json"})
        score = clean_score(body.get("score"))
        if score is None:
            return self.reply(400, {"error": "bad score"})
        name = clean_name(body.get("name"))
        ip = self.client_ip()
        now = time.time()
        with _lock:
            if not allow(ip, now):
                return self.reply(429, {"error": "too fast"})
            row = {
                # Миллисекунда плюс случайность: две записи в одну миллисекунду
                # (звонок — весь класс разбивается разом) не должны делить id.
                "id": "%x%s" % (int(now * 1000), os.urandom(4).hex()),
                "name": name,
                "score": score,
                "at": now,
                "host": (self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or "").split(":")[0],
            }
            rows = ordered(load() + [row])[:KEEP]
            save(rows)
            table = board(rows)
            # Место считается среди имён, и отвечает за него лучшая попытка этого
            # имени — возможно, не та, что пришла сейчас. Клиент подсвечивает её.
            k = key_of(row)
            mine = next((r for r in table if key_of(r) == k), None)
            top = [public(r) for r in table[:TOP]]
            counts = summary(rows)
        if mine is None:
            # Хранилище полно, и попытка хуже всех пятисот: ничего не сохранено.
            return self.reply(200, {"id": row["id"], "name": name, "rank": None, "best": None,
                                    "improved": False, "top": top, **counts})
        self.reply(200, {
            "id": mine["id"], "name": mine["name"], "rank": table.index(mine) + 1,
            "best": mine["score"], "improved": row["score"] >= mine["score"],
            "top": top, **counts,
        })


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    sys.stderr.write("colloq-capy: 127.0.0.1:%d, store %s%s\n" % (PORT, STORE, " + page" if PAGE else ""))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
