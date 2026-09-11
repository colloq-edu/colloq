#!/usr/bin/env python3
"""Зеркало неизменяемой статики занятия на самом ретрансляторе.

Зачем. Всё, что видит студент, ехало через туннель с ноутбука преподавателя:
каждый /assets/*, каждый шрифт, каждый кусок pdf.js — по 598 КБ сжатого на
каждого пришедшего, через Wi-Fi аудитории, через frpc, через frps и обратно.
Двести человек по звонку — это двести таких проходов по одному и тому же
каналу, и ими же он и забивается: пока грузится страница, по этому же туннелю
идут сокеты комнаты.

А файлы-то одинаковые. У /assets/* имя содержит хэш содержимого (их и отдают с
immutable на год), /fonts/* и /pdf/* меняются только с выкладкой. Значит их
можно держать на ретрансляторе и отдавать оттуда, а туннель оставить тому,
ради чего он есть, — живой комнате.

    PUT /.relay/assets/<имя>   ← tar.gz из web/dist: assets/, fonts/, pdf/
                                 Authorization: Bearer <общий секрет>
                               → {"host", "files", "bytes", "kept", "skipped"}
    GET /.relay/assets/<имя>   → {"host", "files", "bytes", "updated"} — что
                                 сейчас лежит в зеркале (тем же секретом)

Живёт на петле (127.0.0.1:9182) за caddy: тот отдаёт ему путь
/.relay/assets/* на любом имени под своей зоной. Путь начинается с точки — ни
один адрес инстанса так не выглядит, и маршрут ничего у комнаты не отнимает.
Ставится scripts/relay-setup.sh как служба colloq-assets от отдельного
пользователя; данные в /var/lib/colloq-assets.

Раздаёт файлы НЕ этот сервис, а caddy, прямо из каталога (file_server с
precompressed br gzip). Промах зеркала — не отказ: в Caddyfile стоит матчер
`file`, и если файла нет, запрос идёт в туннель как раньше. Пустое, устаревшее
или выключенное зеркало не ломает ничего, только возвращает прежнюю скорость.

Кто чей. Секрет тот же, что у frps: он уже есть у всякого, кто вправе занять
поддомен. Имя в пути должно совпасть с именем, по которому пришёл запрос
(X-Forwarded-Host от caddy), — то есть hse.colloq.ru может переписать только
своё зеркало и только через свой же туннельный адрес.

Почему стандартная библиотека: на ретрансляторе нет ни node, ни pip — это
машина с тремя демонами и секретом. python3 в Ubuntu есть всегда.

    ROOT/<имя>                 → символьная ссылка на sets/<имя>/<отметка>
    ROOT/sets/<имя>/<отметка>/  {assets,fonts,pdf}
    ROOT/.tmp/                  распаковка до подмены

Подмена — переименование ссылки: запрос застаёт либо прежний набор целиком,
либо новый целиком. Файлы прежнего набора из assets/, которым меньше 30 дней,
переносятся в новый ЖЁСТКОЙ ССЫЛКОЙ: вкладка, открытая до выкладки, догружает
свои куски по старым хэшам ещё месяц, а места это не стоит.

Проверка руками, без ретранслятора:
    ASSETS_ROOT=/tmp/mirror ASSETS_PORT=9182 ASSETS_TOKEN_FILE=/tmp/token \
        ASSETS_DOMAIN=colloq.ru python3 scripts/relay-assets.py
Уборка раз в сутки (таймер colloq-assets-prune):
    python3 scripts/relay-assets.py --prune
"""

import hmac
import json
import os
import posixpath
import re
import shutil
import sys
import tarfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.environ.get("ASSETS_ROOT", "/var/lib/colloq-assets")
PORT = int(os.environ.get("ASSETS_PORT", "9182"))
DOMAIN = os.environ.get("ASSETS_DOMAIN", "colloq.ru")
# Секрет читается либо из /etc/colloq-relay/token, либо — под systemd — из
# каталога учётных данных: LoadCredential= даёт службе копию файла, не пуская
# её в каталог frps и не заводя лишнего членства в группе.
TOKEN_FILE = os.environ.get("ASSETS_TOKEN_FILE") or os.path.join(
    os.environ.get("CREDENTIALS_DIRECTORY", "/etc/colloq-relay"), "token"
)
PREFIX = "/.relay/assets/"
# Что вообще бывает в web/dist и стоит зеркалить. Всё остальное — index.html,
# robots.txt, служебное — отдаёт инстанс: страница живая, её кэшировать нельзя.
DIRS = ("assets", "fonts", "pdf")
MAX_BYTES = int(os.environ.get("ASSETS_MAX_BYTES", str(64 * 1024 * 1024)))
MAX_FILES = int(os.environ.get("ASSETS_MAX_FILES", "4000"))
# Сколько живут куски прежней сборки. Месяц — это запас на вкладку, забытую
# открытой на всё межсессионное время; имена с хэшем не сталкиваются.
KEEP_DAYS = float(os.environ.get("ASSETS_KEEP_DAYS", "30"))
# Сколько ждать имя, которое перестали выставлять наружу, прежде чем убрать его
# зеркало целиком. Вдвое дольше срока кусков: удалять то, на что ещё ссылаются
# живые вкладки, незачем.
FORGET_DAYS = KEEP_DAYS * 2

SETS = os.path.join(ROOT, "sets")
STAGE = os.path.join(ROOT, ".tmp")


def make_staging(host):
    """Свежий каталог распаковки под STAGE: 0750 с учётом umask, без chmod.

    Имя со случайным хвостом, как у mkdtemp; отличие одно — режим задаётся
    при создании, чтобы не трогать бит setgid, унаследованный от STAGE.
    """
    import secrets
    for _ in range(100):
        path = os.path.join(STAGE, "%s-%s" % (host, secrets.token_hex(4)))
        try:
            os.mkdir(path, 0o750)
        except FileExistsError:
            continue
        return path
    raise RuntimeError("no free staging name")

# Имя файла внутри архива: буквы, цифры, точка, дефис, подчёркивание. Хэши
# Vite, шрифты и pdf.worker.min.mjs укладываются в это целиком, а всё
# остальное — повод отказать, а не разбираться.
PART = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._-]*\Z")
HOST = re.compile(r"[a-z0-9][a-z0-9-]*\.%s\Z" % re.escape(DOMAIN))

_hosts = {}
_hosts_lock = threading.Lock()


def lock_for(host):
    # По замку на имя: две выкладки одного семинара не должны подменять набор
    # друг у друга, а разные семинары друг другу не мешают.
    with _hosts_lock:
        if host not in _hosts:
            _hosts[host] = threading.Lock()
        return _hosts[host]


def secret():
    try:
        with open(TOKEN_FILE, "rb") as f:
            return f.read().strip()
    except OSError:
        return b""


class Reject(Exception):
    """Отказ с кодом и словом для журнала: архив не тот, что обещали."""

    def __init__(self, code, why):
        super().__init__(why)
        self.code = code
        self.why = why


def checked_name(name):
    """Путь внутри архива — или Reject. Возвращает None для того, что пропускаем."""
    normalized = posixpath.normpath(name)
    if normalized in (".", "/") or normalized.startswith("/") or "\x00" in normalized:
        raise Reject(400, "path")
    parts = normalized.split("/")
    if parts[0] not in DIRS:
        raise Reject(400, "prefix")
    for part in parts:
        if part == ".." or part == ".":
            raise Reject(400, "path")
        # Скрытое не зеркалим и не отказываем из-за него: .DS_Store с ноутбука
        # преподавателя не повод не выложить сборку.
        if part.startswith("."):
            return None
        if not PART.match(part):
            raise Reject(400, "name")
    if len(normalized) > 255 or len(parts) > 8:
        raise Reject(400, "name")
    return normalized


def unpack(stream, into):
    """Распаковка своей рукой: никаких ссылок, устройств и путей наружу."""
    files = 0
    total = 0
    skipped = 0
    with tarfile.open(fileobj=stream, mode="r|gz") as tar:
        for member in tar:
            if member.isdir():
                inside = checked_name(member.name)
                if inside:
                    os.makedirs(os.path.join(into, inside), exist_ok=True)
                continue
            if not member.isreg():
                # Символьная ссылка в архиве — самый дешёвый способ заставить
                # caddy отдать /etc/shadow под видом чанка.
                raise Reject(400, "kind")
            relative = checked_name(member.name)
            if relative is None:
                skipped += 1
                continue
            files += 1
            total += member.size
            if files > MAX_FILES:
                raise Reject(413, "files")
            if total > MAX_BYTES:
                raise Reject(413, "bytes")
            source = tar.extractfile(member)
            if source is None:
                raise Reject(400, "kind")
            target = os.path.join(into, relative)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o640)
            with os.fdopen(fd, "wb") as out:
                shutil.copyfileobj(source, out, 1 << 16)
    return files, total, skipped


def carry_over(previous, staging, now):
    """Куски прежней сборки моложе KEEP_DAYS — жёсткой ссылкой в новый набор."""
    kept = 0
    old = os.path.join(previous, "assets")
    if not os.path.isdir(old):
        return kept
    cutoff = now - KEEP_DAYS * 86400
    for directory, _, names in os.walk(old):
        for name in names:
            source = os.path.join(directory, name)
            relative = os.path.relpath(source, previous)
            target = os.path.join(staging, relative)
            if os.path.exists(target):
                continue
            try:
                if os.lstat(source).st_mtime < cutoff:
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                os.link(source, target)
            except OSError:
                continue
            kept += 1
    return kept


def current_set(host):
    link = os.path.join(ROOT, host)
    try:
        return os.path.realpath(link) if os.path.islink(link) else None
    except OSError:
        return None


def swap(host, staging, now):
    """Новый набор на место прежнего — переименованием, а не копированием."""
    home = os.path.join(SETS, host)
    os.makedirs(home, exist_ok=True)
    stamp = "%s-%s" % (time.strftime("%Y%m%d-%H%M%S", time.gmtime(now)), os.urandom(3).hex())
    final = os.path.join(home, stamp)
    os.replace(staging, final)
    link = os.path.join(ROOT, host)
    # Ретранслятор, поставленный до появления зеркала, мог оставить на этом
    # месте обычный каталог: переименовать ссылку поверх него нельзя.
    if os.path.isdir(link) and not os.path.islink(link):
        shutil.rmtree(link, ignore_errors=True)
    temporary = os.path.join(ROOT, ".swap-%s-%s" % (host, os.urandom(4).hex()))
    os.symlink(os.path.join("sets", host, stamp), temporary)
    os.replace(temporary, link)
    # Прежние наборы больше не нужны: то, что из них пережило выкладку, лежит в
    # новом жёсткой ссылкой, а на открытые сейчас файлы удаление не влияет.
    for name in os.listdir(home):
        if name != stamp:
            shutil.rmtree(os.path.join(home, name), ignore_errors=True)
    return final


def measure(directory):
    files = 0
    bytes_ = 0
    for where, _, names in os.walk(directory):
        for name in names:
            try:
                bytes_ += os.lstat(os.path.join(where, name)).st_size
            except OSError:
                continue
            files += 1
    return files, bytes_


def prune(now=None):
    """Суточная уборка: брошенные имена, обрывки распаковки, старые наборы."""
    now = now or time.time()
    removed = []
    for host in sorted(os.listdir(SETS) if os.path.isdir(SETS) else []):
        home = os.path.join(SETS, host)
        live = current_set(host)
        for name in sorted(os.listdir(home)):
            version = os.path.join(home, name)
            if live and os.path.realpath(version) == live:
                continue
            shutil.rmtree(version, ignore_errors=True)
            removed.append(os.path.join("sets", host, name))
        # Имя, которое перестали выставлять наружу совсем. Ссылка обновляется
        # на каждую выкладку, поэтому её время — это время последней пары.
        try:
            age = now - os.lstat(os.path.join(ROOT, host)).st_mtime
        except OSError:
            age = FORGET_DAYS * 86400 + 1
        if age > FORGET_DAYS * 86400:
            shutil.rmtree(home, ignore_errors=True)
            try:
                os.unlink(os.path.join(ROOT, host))
            except OSError:
                pass
            removed.append(host)
    for name in sorted(os.listdir(STAGE) if os.path.isdir(STAGE) else []):
        leftover = os.path.join(STAGE, name)
        try:
            if now - os.lstat(leftover).st_mtime < 3600:
                continue
        except OSError:
            continue
        shutil.rmtree(leftover, ignore_errors=True)
        removed.append(os.path.join(".tmp", name))
    return removed


class Handler(BaseHTTPRequestHandler):
    server_version = "colloq-assets/1"
    protocol_version = "HTTP/1.1"
    # Недосказанное тело не должно держать поток вечно. Архив идёт по петле от
    # caddy, а не из аудитории, но выкладка — это десяток мегабайт.
    timeout = 300

    def handle(self):
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    def log_message(self, fmt, *args):
        code = str(args[1]) if len(args) > 1 else ""
        if code[:1] in ("4", "5"):
            sys.stderr.write("%s\n" % (fmt % args))

    def reply(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if self.close_connection:
            self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def refuse(self, code, body):
        # Тело запроса не прочитано — остаток лёг бы в сокет и разобрался как
        # следующий запрос.
        self.close_connection = True
        self.reply(code, body)

    def authorized(self):
        want = secret()
        given = self.headers.get("Authorization", "")
        prefix = "Bearer "
        if not want or not given.startswith(prefix):
            return False
        return hmac.compare_digest(given[len(prefix):].strip().encode(), want)

    def target(self):
        """Имя из пути — и оно же должно быть тем, по которому пришёл запрос."""
        path = self.path.split("?", 1)[0]
        if not path.startswith(PREFIX):
            raise Reject(404, "not found")
        host = path[len(PREFIX):].strip("/").lower()
        if not HOST.match(host) or len(host) > 100:
            raise Reject(400, "host")
        came = (self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or "")
        came = came.split(":")[0].strip().lower()
        # Своё зеркало и только своё: секрет общий на весь ретранслятор, и без
        # этой проверки любой семинар переписал бы статику соседнего.
        if came != host:
            raise Reject(403, "host")
        return host

    def do_GET(self):
        try:
            host = self.target()
        except Reject as no:
            return self.reply(no.code, {"error": no.why})
        if not self.authorized():
            return self.reply(401, {"error": "token"})
        live = current_set(host)
        if not live or not os.path.isdir(live):
            return self.reply(404, {"error": "empty", "host": host})
        files, bytes_ = measure(live)
        return self.reply(200, {
            "host": host, "files": files, "bytes": bytes_,
            "updated": int(os.lstat(live).st_mtime),
        })

    do_HEAD = do_GET

    def do_PUT(self):
        try:
            host = self.target()
        except Reject as no:
            return self.refuse(no.code, {"error": no.why})
        if not self.authorized():
            return self.refuse(401, {"error": "token"})
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 0:
            # Длина обязательна: без неё нечем остановить поток до распаковки.
            return self.refuse(411, {"error": "length"})
        if length > MAX_BYTES:
            return self.refuse(413, {"error": "bytes"})
        os.makedirs(STAGE, exist_ok=True)
        now = time.time()
        with lock_for(host):
            # Не mkdtemp: он делает 0700, а chmod после него — ловушка. Каталог
            # наследует от STAGE группу caddy и бит setgid, но chmod от
            # пользователя, который в группу caddy не входит, этот бит молча
            # снимает — и всё, что распакуется внутрь, получает группу процесса
            # (assets). Зеркало тогда лежит на диске целиком, а caddy его не
            # читает и без единого слова ходит в туннель; так и случилось при
            # первой выкладке 12.09.2026. Поэтому mkdir с нужным режимом сразу
            # и ни одного chmod: setgid и группа приходят от родителя сами.
            staging = make_staging(host)
            try:
                files, bytes_, skipped = unpack(Body(self.rfile, length), staging)
                if files == 0:
                    raise Reject(400, "empty")
                previous = current_set(host)
                kept = carry_over(previous, staging, now) if previous else 0
                swap(host, staging, now)
            except Reject as no:
                shutil.rmtree(staging, ignore_errors=True)
                return self.refuse(no.code, {"error": no.why})
            except (tarfile.TarError, EOFError, OSError) as bad:
                shutil.rmtree(staging, ignore_errors=True)
                sys.stderr.write("%s: %s\n" % (host, bad))
                return self.refuse(400, {"error": "tar"})
        self.reply(200, {"host": host, "files": files, "bytes": bytes_,
                         "kept": kept, "skipped": skipped})


class Body:
    """Ровно Content-Length байт из сокета и ни одним больше."""

    def __init__(self, stream, length):
        self.stream = stream
        self.left = length

    def read(self, size=-1):
        if self.left <= 0:
            return b""
        if size is None or size < 0:
            size = self.left
        chunk = self.stream.read(min(size, self.left))
        self.left -= len(chunk)
        return chunk


def main():
    os.makedirs(SETS, exist_ok=True)
    os.makedirs(STAGE, exist_ok=True)
    if "--prune" in sys.argv[1:]:
        for name in prune():
            sys.stderr.write("colloq-assets: убрано %s\n" % name)
        return
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    sys.stderr.write("colloq-assets: 127.0.0.1:%d, зеркало %s, зона %s\n" % (PORT, ROOT, DOMAIN))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
