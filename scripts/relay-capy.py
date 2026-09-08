#!/usr/bin/env python3
"""Таблица рекордов для игры на странице ожидания ретранслятора.

Страница «комната ещё не открыта» (scripts/relay-offline.html) занимает
студента пиксельной капибарой, пока преподаватель не открыл комнату, и
предлагает вписать очки в общую таблицу. Таблица — это и есть весь сервис:
одна JSON-коллекция на диске и три запроса.

    GET  /.relay/capy/start    → {"run": жетон}   — выдаётся в начале забега
    GET  /.relay/capy/scores   → {"top": [{"id", "name", "score"}...],
                                  "total": попыток, "names": разных имён}
    POST /.relay/capy/scores   ← {"name", "score", "run": жетон, "owner": ключ}
                               → {"id", "name", "rank", "best", "improved",
                                  "renamed", "total", "names", "top": [...]}
                                 id, name и best — строки этого имени в таблице
                                 (лучшей попытки); rank: null — очков не
                                 хватило даже на хвост хранилища.
                                 409 — имя закреплено за другим владельцем.

Живёт на петле (127.0.0.1:9181) за caddy: тот отдаёт ему путь /.relay/capy/*
для любого имени под *.colloq.ru — путь начинается с точки, чтобы не пересечься
ни с одним адресом инстанса. Ставится и обновляется scripts/relay-setup.sh как
systemd-служба colloq-capy от отдельного пользователя; данные в
/var/lib/colloq-capy/ — scores.json и secret.

Почему стандартная библиотека, а не что-то удобнее: на ретрансляторе нет ни
node, ни pip, ни желания их туда тащить — это машина с двумя демонами и
секретом, и каждая лишняя зависимость на ней лишняя. python3 в Ubuntu есть
всегда.

Кто чей. Браузер один раз заводит себе случайный ключ владельца и шлёт его с
каждой записью; сервис хранит только его хэш. Имя — подпись владельца, а не
сама личность: вписал другое — все строки этого владельца переезжают под
новое имя вместе с рекордом (так «test» становится «sleep3r», а не вторым
игроком). Имя, за которым уже стоит другой владелец, занять нельзя — 409;
ничьи строки (записанные до этого правила) забирает первый, кто под ними
запишется со своим ключом. Оборотная сторона: тот же человек с другого
устройства — другой владелец, и своё имя он там не получит; это цена того,
что никто не впишет 99 999 под чужим именем.

Записи БЕЗ ключа не принимаются вовсе — 400. Раньше проверка владельца стояла
внутри «если ключ прислали», и `curl` без ключа писал что угодно под любым
чужим именем: правило про 409 обходилось тем, что его просто не спрашивали.

Честность очков. В начале забега страница берёт жетон — подписанное время
старта. Запись без жетона или с чужим не принимается; очки сверяются со
временем, прошедшим по часам сервиса: игра честно набирает до ~37 в секунду,
принимается до 40·с + 50. Жетон одноразовый на имя (переименование той же
попытки — законно, повтор под тем же именем — нет). Это не защита от того,
кто перепишет игру, а защита от curl за минуту до звонка.

Таблица — одна строка на имя: лучший результат человека, а не все его попытки
подряд. Имена сравниваются без учёта регистра. Попытки считаются все — это
число над таблицей.

Безымянных строк в таблице нет. Раньше пустое имя становилось «Анонимом», и
каждая такая попытка занимала СВОЮ вечную строку: к восьми строкам таблицы
пять были «Анонимами» — таблица про людей превращалась в ленту попыток.
Играть без имени по-прежнему можно сколько угодно, а строка в таблице
начинается с имени. Прежние безымянные строки остались в файле и считаются
в попытках, но не показываются.

Что ещё проверяется: имя — до 16 знаков, без управляющих и невидимых
символов, хотя бы с одним видимым; «Аноним» — прежняя метка безымянных строк,
а не имя, и его не занять. Очки — целое от 0 до 99 999. Лимит на адрес — корзина: пять записей сразу, дальше по одной
в три секунды (класс за одним NAT помещается, поток curl — нет). Адрес берётся
из ПОСЛЕДНЕГО элемента X-Forwarded-For: его дописывает caddy, первый присылает
клиент. Таблица хранит пятьсот лучших; ответ считается по сохранённому.

Проверка руками, без ретранслятора:
    CAPY_STATE=/tmp/capy CAPY_PORT=9181 CAPY_PAGE=scripts/relay-offline.html \
        python3 scripts/relay-capy.py
и открыть http://127.0.0.1:9181/ — с CAPY_PAGE сервис отдаёт страницу на любой
путь, чтобы игру и таблицу можно было погонять с одного адреса.
"""

import hashlib
import hmac
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
SECRET_FILE = os.path.join(STATE_DIR, "secret")
PORT = int(os.environ.get("CAPY_PORT", "9181"))
PAGE = os.environ.get("CAPY_PAGE")  # только для проверки руками

PATH = "/.relay/capy/scores"
START = "/.relay/capy/start"
KEEP = 500
TOP = 10
NAME_MAX = 16
SCORE_MAX = 99_999
BODY_MAX = 2048
# Имя прежних безымянных строк: в таблице им места нет, но в файле они лежат.
ANON = "Аноним"
# Корзина на адрес: BURST записей сразу, дальше одна в REFILL_SECONDS.
BURST = 5
REFILL_SECONDS = 3.0
# Честность: очков в секунду сверх которых игра не набирает, и запас.
POINTS_PER_SECOND = 40
POINTS_SLACK = 50
RUN_MAX_AGE = 6 * 3600  # жетон старше — просрочен

_lock = threading.Lock()
_buckets = {}  # адрес → (токенов, когда считали)
_used = {}  # (жетон, ключ имени) → когда использован


def load_secret():
    try:
        with open(SECRET_FILE, "rb") as f:
            s = f.read()
        if len(s) >= 32:
            return s
    except OSError:
        pass
    os.makedirs(STATE_DIR, exist_ok=True)
    s = os.urandom(32)
    fd = os.open(SECRET_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(s)
    return s


SECRET = load_secret()


def make_run(now):
    start = "%x" % int(now * 1000)
    nonce = os.urandom(6).hex()
    sig = hmac.new(SECRET, ("%s.%s" % (start, nonce)).encode(), hashlib.sha256).hexdigest()[:20]
    return "%s.%s.%s" % (start, nonce, sig)


def run_started(token):
    # Возвращает время старта (с) или None, если жетон не наш.
    if not isinstance(token, str) or token.count(".") != 2 or len(token) > 80:
        return None
    start, nonce, sig = token.split(".")
    want = hmac.new(SECRET, ("%s.%s" % (start, nonce)).encode(), hashlib.sha256).hexdigest()[:20]
    if not hmac.compare_digest(want, sig):
        return None
    try:
        return int(start, 16) / 1000
    except ValueError:
        return None


def owner_hash(value):
    if not isinstance(value, str) or not (16 <= len(value) <= 64) or not re.fullmatch(r"[0-9a-f]+", value):
        return None
    return hashlib.sha256(value.encode()).hexdigest()[:16]


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
        and (r.get("owner") is None or isinstance(r.get("owner"), str))
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
    # Ключ склейки: имя без регистра.
    return row["name"].casefold()


def board(rows):
    # Упорядоченные строки без повторов имени: первая встреча — лучшая.
    # Прежние безымянные строки пропускаются: таблица — про имена.
    seen = set()
    out = []
    for r in ordered(rows):
        if r["name"] == ANON:
            continue
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
    # Считается по хранимым пятистам: точнее и не нужно. Попытки — все, включая
    # прежние безымянные; имена — только те, что в таблице и есть.
    return {
        "total": len(rows),
        "names": len({key_of(r) for r in rows if r["name"] != ANON}),
    }


# Управляющие и невидимые: нулевой ширины, направление письма, изоляты,
# соединители, филлеры хангыля, BOM — всё, чем можно сделать имя пустым на
# вид или перевернуть соседей в таблице.
_CONTROL = re.compile(
    "[\\x00-\\x1f\\x7f-\\x9f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e"
    "\\u2060-\\u2064\\u206a-\\u206f\\u3164\\ufe00-\\ufe0f\\ufeff\\u115f\\u1160]"
)


def clean_name(value):
    """Имя — или None, если имени нет.

    None, а не «Аноним»: безымянная запись теперь не принимается вовсе, и
    отличать «не вписал» от «вписал» должен тот, кто отвечает клиенту.
    """
    if not isinstance(value, str):
        return None
    value = _CONTROL.sub("", value)
    value = " ".join(value.split())[:NAME_MAX].strip()
    # Хотя бы один видимый знак — буква, цифра, знак препинания или символ.
    # Всё новое невидимое из будущих версий Unicode отсекается категорией,
    # а не списком выше.
    if not any(unicodedata.category(c)[0] in "LNPS" for c in value):
        return None
    # «Аноним» — метка прежних безымянных строк, а не имя: заняв его, человек
    # получил бы вместе с ним чужие строки, которых в таблице и быть не должно.
    if value.casefold() == ANON.casefold():
        return None
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


def prune_used(now):
    if len(_used) > 20_000:
        for k in [k for k, t in _used.items() if now - t > RUN_MAX_AGE]:
            del _used[k]


class Handler(BaseHTTPRequestHandler):
    server_version = "colloq-capy/4"
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
        if path == START:
            return self.reply(200, {"run": make_run(time.time())})
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
        if name is None:
            return self.reply(400, {"error": "name"})
        # Ключ владельца обязателен: без него имя не за кем закрепить, и
        # проверка «имя занято» ниже становится проверкой ни о чём — раньше она
        # стояла внутри «если ключ прислали», и запись без ключа проходила под
        # любым чужим именем.
        owner = owner_hash(body.get("owner"))
        if owner is None:
            return self.reply(400, {"error": "owner"})
        now = time.time()

        # Жетон начала забега: без него, с чужим или просроченным — не запись.
        started = run_started(body.get("run"))
        if started is None or started > now + 60 or now - started > RUN_MAX_AGE:
            return self.reply(400, {"error": "run"})
        # Столько очков за столько секунд игра не набирает.
        if score > POINTS_PER_SECOND * max(0.0, now - started) + POINTS_SLACK:
            return self.reply(400, {"error": "implausible"})

        ip = self.client_ip()
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
            key = key_of(row)
            used_key = (body.get("run"), key)
            if used_key in _used:
                return self.reply(400, {"error": "run"})
            rows = load()
            renamed = False
            row["owner"] = owner
            # Имя за другим владельцем — занято.
            if any(key_of(r) == key and r.get("owner") not in (None, owner) for r in rows):
                return self.reply(409, {"error": "name taken"})
            # Свои строки под прежним именем переезжают под новое.
            for r in rows:
                if r.get("owner") == owner and key_of(r) != key:
                    r["name"] = name
                    renamed = True
            # Ничьи строки под этим именем становятся своими.
            for r in rows:
                if key_of(r) == key and r.get("owner") is None:
                    r["owner"] = owner
            _used[used_key] = now
            prune_used(now)
            rows = ordered(rows + [row])[:KEEP]
            save(rows)
            table = board(rows)
            # Место считается среди имён, и отвечает за него лучшая попытка этого
            # имени — возможно, не та, что пришла сейчас. Клиент подсвечивает её.
            mine = next((r for r in table if key_of(r) == key), None)
            top = [public(r) for r in table[:TOP]]
            counts = summary(rows)
        if mine is None:
            # Хранилище полно, и попытка хуже всех пятисот: ничего не сохранено.
            return self.reply(200, {"id": row["id"], "name": name, "rank": None, "best": None,
                                    "improved": False, "renamed": renamed, "top": top, **counts})
        self.reply(200, {
            "id": mine["id"], "name": mine["name"], "rank": table.index(mine) + 1,
            "best": mine["score"], "improved": row["score"] >= mine["score"],
            "renamed": renamed, "top": top, **counts,
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
