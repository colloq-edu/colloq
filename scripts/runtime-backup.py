#!/usr/bin/env python3
"""Portable application recovery. No cluster credentials are stored in the archive.

The shell wrapper owns writer quiescence. A live backup is SQLite-consistent but
its filesystem files are copied at different instants. Checksums detect damage,
not a maliciously replaced backup: keep archives private and trusted.

Student code leaves more than files in a room: symlinks (`python -m venv` makes
a dozen), FIFOs, sockets, files it made unreadable. None of that may stop a
backup, because an update takes one with the classes already stopped. Links
are stored as links and never followed, neither when copying nor when
restoring; FIFOs, sockets and device nodes are skipped with a warning that
names their full path; only a real I/O error stops the backup, and it names
the path too.
"""
import argparse
import contextlib
import datetime
import errno
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
import sys
import tarfile
import tempfile

RESTORE_MARKER = '.restore-in-progress'
TREES = ('data', 'workspace', 'secrets')
TOP_LEVEL = TREES + ('release.json', 'catalog.json', 'manifest.json', 'config.env')
ARCHIVE_ORDER = ('manifest.json', 'release.json', 'catalog.json', 'config.env') + TREES
# Entries that must be regular files: the tools read them, and a link there
# would make them read something else.
FILES_ONLY = frozenset(('release.json', 'catalog.json', 'manifest.json', 'config.env', 'data/colloq.db'))
DATABASE_FILES = ('colloq.db', 'colloq.db-wal', 'colloq.db-shm')
# What the data tree copy leaves out: the live database (copied consistently on
# its own) and the snapshots the server keeps of it (server/src/db-snapshots.ts),
# which are whole databases: N of them in every archive would multiply its size
# and add nothing a restore of this archive could use.
DATA_EXCLUDED = DATABASE_FILES + ('snapshots',)
# The disk that receives a backup usually holds the live database as well. A
# backup that fills it stops notebook saves in every running class, so the
# backup stops itself before that, and says why.
FREE_FLOOR = 1024 ** 3
# A student can make a million FIFOs; the operator needs the first few names
# and a count, not a million lines.
WARN_LIMIT = 50
# Every directory on the current path holds a descriptor. Deeper trees than
# this are skipped with a warning instead of running out of descriptors.
MAX_DEPTH = 256
# What `backup.sh` names its archives; retention touches nothing else.
ARCHIVE_NAME = re.compile(r'colloq-([0-9]{8}T[0-9]{6}Z)-(?:live|consistent)\.tar\.gz(?:\.age)?')
DENIED = (errno.EACCES, errno.EPERM)
# Removed, or swapped for a link or a file, between listing and opening: a live
# class writes while it is being copied.
GONE = (errno.ENOENT, errno.ENOTDIR, errno.ELOOP)
KINDS = {'fifo': 'a FIFO', 'socket': 'a socket', 'device': 'a device node', 'special': 'a special file',
         'unreadable': 'an unreadable entry', 'deep': 'a directory nested too deep'}


def operation_lock(root):
    spec = importlib.util.spec_from_file_location('colloq_state_lock', Path(__file__).with_name('state-lock.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.acquire(root)


def sync_directory(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def write_restore_marker(root, value):
    fd, name = tempfile.mkstemp(prefix='.restore-state-', dir=root)
    temporary = Path(name)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, root / RESTORE_MARKER)
        sync_directory(root)
    finally:
        if temporary.exists():
            temporary.unlink()


def clear_restore_marker(root):
    (root / RESTORE_MARKER).unlink()
    sync_directory(root)


def durable_rename(source, destination):
    source.rename(destination)
    sync_directory(source.parent)
    if source.parent != destination.parent:
        sync_directory(destination.parent)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def human(size):
    return '%.1f GiB' % (size / 1024 ** 3)


def digest(path):
    with path.open('rb') as stream:
        return digest_stream(stream)


def digest_stream(stream):
    h = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        h.update(block)
    return h.hexdigest()


def read_only(path):
    return contextlib.closing(sqlite3.connect(Path(path).absolute().as_uri() + '?mode=ro', uri=True))


def quick_check(path):
    with read_only(path) as db:
        require(db.execute('PRAGMA quick_check').fetchall() == [('ok',)], 'SQLite quick_check failed')


def database_schema(path):
    """The data schema stamped into a database (server/src/data-schema.ts).

    A file from before the stamp existed carries 0 and reads as 1: every
    release up to that point wrote the schema of version 1.
    """
    with read_only(path) as db:
        return max(1, int(db.execute('PRAGMA user_version').fetchone()[0]))


def schema_list(values):
    return ', '.join(str(v) for v in values) or 'none'


def require_database_schema(path, selected, what):
    """A release must list the schema its database already carries.

    The release manifests say which schema the data should have; the file
    says which it has. They part ways after an update whose manifest was built
    before the schema existed, or a rollback forced past the manifest check.
    """
    have = database_schema(path)
    supported = selected.get('compatibleDataSchemaVersions', [])
    require(have in supported,
            'selected release is incompatible with %s: its database is at data schema %d, and release %s supports %s. '
            'Newer code has written it; restore a backup taken before that code instead of running older code '
            'over it (RELEASING.md, "Data schema").' % (what, have, selected.get('version', '?'), schema_list(supported)))
    return have


class Report:
    """What a walk met besides plain files, folders and links, for the operator."""

    def __init__(self, quiet=False):
        # Quiet lists only the counts: the preflight has already named every path.
        self.quiet = quiet
        self.skipped = {}
        self.named = 0
        self.changed = 0

    def skip(self, kind, path):
        self.skipped[kind] = self.skipped.get(kind, 0) + 1
        self.note('skipped %s: %s' % (KINDS[kind], path))

    def note(self, text):
        if not self.quiet and self.named < WARN_LIMIT:
            print('backup: ' + text, file=sys.stderr)
        self.named += 1

    def finish(self):
        total = sum(self.skipped.values())
        if total and (self.quiet or self.named > WARN_LIMIT):
            counts = ', '.join('%d %s' % (n, kind) for kind, n in sorted(self.skipped.items()))
            print('backup: skipped entries that are not files, folders or links, or cannot be read: ' + counts,
                  file=sys.stderr)
        if self.changed:
            print('backup: %d entries changed or disappeared while they were read; a live backup copies files '
                  'at different instants' % self.changed, file=sys.stderr)


class SpaceGuard:
    """Stops a backup before it fills the disk it writes to, whatever the estimate said."""
    STEP = 64 * 1024 * 1024

    def __init__(self, directory):
        self.directory = directory
        self.pending = 0

    def wrote(self, count):
        self.pending += count
        if self.pending >= self.STEP:
            self.pending = 0
            self.check()

    def check(self):
        free = shutil.disk_usage(self.directory).free
        require(free >= FREE_FLOOR,
                'backup stopped before the disk filled: only %s is left on the filesystem of %s, and a full disk '
                'stops notebook saves. Free space or write the backup to another disk.' % (human(free), self.directory.parent))


class GuardedFile:
    """The archive's file, counting what gzip writes into it for the space guard."""

    def __init__(self, stream, guard):
        self.stream = stream
        self.guard = guard

    def write(self, data):
        written = self.stream.write(data)
        self.guard.wrote(len(data))
        return written

    def flush(self):
        self.stream.flush()


def failure(path, error):
    return ValueError('cannot read %s: %s' % (path, os.strerror(error.errno) if error.errno else error))


def kind_of(mode):
    if stat.S_ISFIFO(mode):
        return 'fifo'
    if stat.S_ISSOCK(mode):
        return 'socket'
    if stat.S_ISCHR(mode) or stat.S_ISBLK(mode):
        return 'device'
    return 'special'


def walk(root, report, on_dir, on_file, on_link, excluded=(), open_files=True, extra_depth=0):
    """Visit a tree by descriptor, never following a link.

    Each directory and file is opened relative to its parent's descriptor with
    O_NOFOLLOW: student processes change names while a live backup runs, and
    a symlink swapped in between the stat and the open must not make root read
    outside the tree. Links are handed over as their target string, which is
    only data. FIFOs, sockets and devices are reported and never opened (a
    FIFO would block, a device may act on open). Permission problems are
    reported and skipped; anything else the kernel refuses is an I/O error
    and stops the walk with the full path.

    on_dir(parts, fd, info), on_file(parts, fd, info, path) and
    on_link(parts, target, path) receive the entry's parts below root; fd is
    None for files when open_files is false. Walks over a stage start a level
    or two above the trees the depth cap was applied to, hence extra_depth.
    """
    frames = []
    limit = MAX_DEPTH + extra_depth

    def enter(fd, path, parts, skip=()):
        try:
            names = sorted(name for name in os.listdir(fd) if name not in skip)
        except OSError as error:
            os.close(fd)
            if error.errno in DENIED:
                report.skip('unreadable', path)
                return
            raise failure(path, error)
        frames.append((fd, path, parts, iter(names)))

    enter(os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW), str(root), (), excluded)
    try:
        while frames:
            directory_fd, path, parts, names = frames[-1]
            name = next(names, None)
            if name is None:
                frames.pop()
                os.close(directory_fd)
                continue
            full = os.path.join(path, name)
            relative = parts + (name,)
            try:
                info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            except OSError as error:
                if error.errno in GONE:
                    report.changed += 1
                    continue
                if error.errno in DENIED:
                    report.skip('unreadable', full)
                    continue
                raise failure(full, error)
            if stat.S_ISLNK(info.st_mode):
                try:
                    target = os.readlink(name, dir_fd=directory_fd)
                except OSError as error:
                    if error.errno in GONE + (errno.EINVAL,):
                        report.changed += 1
                        continue
                    raise failure(full, error)
                on_link(relative, target, full)
                continue
            is_dir = stat.S_ISDIR(info.st_mode)
            if not is_dir and not stat.S_ISREG(info.st_mode):
                report.skip(kind_of(info.st_mode), full)
                continue
            if is_dir and len(frames) >= limit:
                report.skip('deep', full)
                continue
            if not is_dir and not open_files:
                on_file(relative, None, info, full)
                continue
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_DIRECTORY if is_dir else 0)
            try:
                opened = os.open(name, flags, dir_fd=directory_fd)
            except OSError as error:
                if error.errno in GONE:
                    report.changed += 1
                    continue
                if error.errno in DENIED:
                    report.skip('unreadable', full)
                    continue
                raise failure(full, error)
            actual = os.fstat(opened)
            if is_dir and stat.S_ISDIR(actual.st_mode):
                try:
                    on_dir(relative, opened, actual)
                except BaseException:
                    os.close(opened)
                    raise
                enter(opened, full, relative)
                continue
            try:
                if not is_dir and stat.S_ISREG(actual.st_mode):
                    on_file(relative, opened, actual, full)
                else:
                    # Replaced by something else between the stat and the open.
                    report.changed += 1
            finally:
                os.close(opened)
    finally:
        for directory_fd, *_ in frames:
            os.close(directory_fd)


def ignore(*_):
    pass


def link_note(report, prefix):
    """Links in a room are the students' business (a venv is made of them).

    data/ and secrets/ are written by the server and the operator, and a link
    there usually means a folder moved to another disk: the backup keeps the
    link, not what it points to, and that must be said.
    """
    def on_link(_parts, target, path):
        if prefix != 'workspace':
            report.note('%s is a symbolic link to %s; the backup keeps the link, not what it points to' % (path, target))
    return on_link


def measure(root, report, open_files=False):
    """Bytes a backup copy of the state takes, found by the same walk, without copying."""
    total = 0

    def count(_parts, _fd, info, _path):
        nonlocal total
        total += info.st_size

    for name, excluded in (('data', DATA_EXCLUDED), ('workspace', ()), ('secrets', ())):
        tree = root / name
        require(not tree.is_symlink(), 'symlink is not allowed: %s (point the state directory at real folders)' % tree)
        if tree.exists():
            walk(tree, report, ignore, count, link_note(report, name), excluded, open_files)
    # The snapshot of the database is at most the file plus its journal.
    for path in (root / 'data/colloq.db', root / 'data/colloq.db-wal', root / 'config.env'):
        with contextlib.suppress(FileNotFoundError):
            total += os.stat(path, follow_symlinks=False).st_size
    return total


def copy_tree(source, destination, report, guard, digests, prefix, excluded=()):
    """Copy one state tree into the stage: files by descriptor, links as links."""
    require(not source.is_symlink(), 'symlink is not allowed: %s (point the state directory at real folders)' % source)
    destination.mkdir(parents=True, exist_ok=True)
    if not source.exists():
        return

    note = link_note(report, prefix)

    def make_dir(parts, _fd, _info):
        destination.joinpath(*parts).mkdir()

    def make_link(parts, target, path):
        os.symlink(target, destination.joinpath(*parts))
        note(parts, target, path)

    def copy_file(parts, fd, info, path):
        target = destination.joinpath(*parts)
        h = hashlib.sha256()
        with os.fdopen(os.dup(fd), 'rb') as stream, target.open('xb') as out:
            while True:
                try:
                    block = stream.read(1024 * 1024)
                except OSError as error:
                    raise failure(path, error)
                if not block:
                    break
                h.update(block)
                out.write(block)
                guard.wrote(len(block))
        target.chmod(0o600 | (info.st_mode & 0o100))
        digests[prefix + '/' + '/'.join(parts)] = h.hexdigest()

    walk(source, report, make_dir, copy_file, make_link, excluded)


def inventory(stage, known=None):
    """Digests of every regular file and targets of every link under stage.

    Never follows a link. `known` carries digests computed while copying: the
    stage is private, so a file written there has not changed since.
    """
    files, links, report = {}, {}, Report(quiet=True)

    def add_file(parts, fd, _info, _path):
        key = '/'.join(parts)
        if known is not None and key in known:
            files[key] = known[key]
        else:
            with os.fdopen(os.dup(fd), 'rb') as stream:
                files[key] = digest_stream(stream)

    def add_link(parts, target, _path):
        links['/'.join(parts)] = target

    walk(stage, report, ignore, add_file, add_link, extra_depth=2)
    require(not report.skipped and not report.changed, 'the stage holds entries that are not files, folders or links')
    return files, links


def write_archive(path, stage, guard):
    with path.open('xb') as raw:
        with tarfile.open(mode='w:gz', fileobj=GuardedFile(raw, guard)) as archive:
            for name in ARCHIVE_ORDER:
                archive.add(stage / name, arcname=name)
        raw.flush()
        os.fsync(raw.fileno())


def backup(args):
    require(args.mode != 'consistent' or args.quiesced, 'consistent backup requires --quiesced after stopping every writer')
    root = Path(args.root).resolve()
    operation_lock(root)
    require(not os.path.lexists(root / RESTORE_MARKER), 'interrupted restore must be recovered before backup')
    require((root / 'data/colloq.db').is_file(), 'application database is missing')
    require(not (root / 'data/colloq.db').is_symlink(), 'database symlink is not allowed')
    release = json.loads(Path(args.release).read_text())
    output = Path(args.output).absolute()
    require(not os.path.lexists(output), 'backup output already exists')
    output.parent.mkdir(parents=True, exist_ok=True)
    # The whole state is copied uncompressed before the archive is written:
    # that copy must fit, with room to spare for the database that keeps
    # working next to it. The archive itself is watched by the space guard.
    need = measure(root, Report(quiet=True)) + FREE_FLOOR
    free = shutil.disk_usage(output.parent).free
    require(free >= need, 'not enough free space for the backup: the copy of data and workspace needs about %s on '
            'the filesystem of %s, and %s is free. Free space or write the backup to another disk.'
            % (human(need), output.parent, human(free)))
    report = Report(quiet=getattr(args, 'brief', False))
    with tempfile.TemporaryDirectory(prefix='.colloq-backup-', dir=output.parent) as directory:
        stage = Path(directory)
        guard = SpaceGuard(stage)
        digests = {}
        copy_tree(root / 'data', stage / 'data', report, guard, digests, 'data', DATA_EXCLUDED)
        copy_tree(root / 'workspace', stage / 'workspace', report, guard, digests, 'workspace')
        copy_tree(root / 'secrets', stage / 'secrets', report, guard, digests, 'secrets')
        config = root / 'config.env'
        require(not config.is_symlink(), 'configuration symlink is not allowed')
        if config.is_file():
            shutil.copy2(config, stage / 'config.env')
        else:
            (stage / 'config.env').touch(mode=0o600)
        with read_only(root / 'data/colloq.db') as source:
            with contextlib.closing(sqlite3.connect(stage / 'data/colloq.db')) as target:
                source.backup(target)
        quick_check(stage / 'data/colloq.db')
        (stage / 'release.json').write_text(json.dumps(release, indent=2) + '\n')
        (stage / 'catalog.json').write_text(json.dumps(release['catalog'], indent=2) + '\n')
        guard.check()
        files, links = inventory(stage, digests)
        manifest = dict(schemaVersion=1, environment=args.name, mode=args.mode,
                        createdAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        fileConsistency='stopped-writers' if args.mode == 'consistent' else 'files-copied-at-different-instants',
                        dataSchemaVersion=release['dataSchemaVersion'],
                        databaseSchemaVersion=database_schema(stage / 'data/colloq.db'),
                        files=files, links=links)
        if report.skipped:
            manifest['skipped'] = dict(sorted(report.skipped.items()))
        (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        temporary = stage / 'archive.tar.gz'
        write_archive(temporary, stage, guard)
        temporary.chmod(0o600)
        # Never replace an existing backup, even if a second process won the race.
        os.link(temporary, output)
        sync_directory(output.parent)
    report.finish()
    print(str(output))


def preflight(args):
    """Everything a consistent backup can refuse for, checked while classes still run.

    backup.sh and cluster.sh update call this before they stop any writer: an
    update must never stop the app and then fail on its backup. The estimate
    is deliberately generous (the uncompressed copy and an archive as large as
    the copy), because a refusal now costs nothing and one after the stop
    costs a class.
    """
    root = Path(args.root).resolve()
    operation_lock(root)
    require(not os.path.lexists(root / RESTORE_MARKER), 'interrupted restore must be recovered before backup')
    database = root / 'data/colloq.db'
    require(database.is_file() and not database.is_symlink(), 'application database is missing: ' + str(database))
    require(isinstance(json.loads(Path(args.release).read_text()).get('dataSchemaVersion'), int), 'release has no dataSchemaVersion')
    output = Path(args.output).absolute()
    require(not os.path.lexists(output), 'backup output already exists: ' + str(output))
    report = Report()
    size = measure(root, report, open_files=True)
    parent = output.parent
    while not parent.exists() and parent != parent.parent:
        parent = parent.parent
    require(os.access(parent, os.W_OK | os.X_OK), 'cannot write backups under ' + str(parent))
    need = 2 * size + FREE_FLOOR
    free = shutil.disk_usage(parent).free
    require(free >= need, 'not enough free space for a backup: it needs about %s on the filesystem of %s (a copy '
            'of data and workspace, then the archive), and %s is free. Free space or write the backup to another disk '
            '(OUT=/path/colloq-....tar.gz). Nothing was stopped.' % (human(need), parent, human(free)))
    report.finish()
    print('backup preflight: %s to copy, %s free on %s' % (human(size), human(free), parent), file=sys.stderr)


def prune(args):
    """Keep the newest --keep archives named like backup.sh names them; never the fresh one."""
    require(args.keep >= 0, 'BACKUP_KEEP must be 0 (keep every backup) or a positive number')
    if args.keep == 0:
        return
    directory = Path(args.directory)
    fresh = Path(args.fresh).name
    found = []
    for name in os.listdir(directory):
        match = ARCHIVE_NAME.fullmatch(name)
        path = directory / name
        if match and not path.is_symlink() and path.is_file():
            found.append((match.group(1), name))
    for _, name in sorted(found, reverse=True)[args.keep:]:
        if name == fresh:
            continue
        (directory / name).unlink()
        print('backup: removed old backup ' + str(directory / name), file=sys.stderr)


def check_schema(args):
    """Refuse an update or rollback to a release that does not list the database's schema."""
    database = Path(args.root) / 'data/colloq.db'
    if database.is_file() and not database.is_symlink():
        require_database_schema(database, json.loads(Path(args.release).read_text()), 'the installed data')


def open_directory(base, parts, entry):
    """Open (and create) stage/parts one component at a time, never through a link.

    A link created by an earlier entry of the same archive must not become the
    road out of the stage for a later one: every component is opened with
    O_NOFOLLOW relative to its parent, so a link where a folder is expected is
    a refusal, not a detour.
    """
    fd = os.dup(base)
    try:
        for part in parts:
            with contextlib.suppress(FileExistsError):
                os.mkdir(part, 0o700, dir_fd=fd)
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except OSError as error:
                if error.errno in (errno.ELOOP, errno.ENOTDIR):
                    raise ValueError('archive entry would be written through a link or into a file: ' + entry) from None
                raise
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def archive_parts(name):
    path = PurePosixPath(name)
    parts = path.parts
    require(name and not path.is_absolute() and parts and '..' not in parts and parts[0] in TOP_LEVEL,
            'unsafe archive path: ' + name)
    return parts


def unpack(archive_path, stage, name):
    stage_fd = os.open(stage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        with tarfile.open(archive_path, 'r:gz') as archive:
            seen = set()
            for member in archive:
                parts = archive_parts(member.name)
                key = '/'.join(parts)
                require(key not in seen, 'duplicate archive path: ' + key)
                seen.add(key)
                if member.isdir():
                    require(key not in FILES_ONLY, 'archive entry must be a file: ' + key)
                    os.close(open_directory(stage_fd, parts, key))
                elif member.issym():
                    require(len(parts) > 1 and parts[0] in TREES and key not in FILES_ONLY,
                            'archive link outside the data, workspace and secrets trees: ' + key)
                    parent = open_directory(stage_fd, parts[:-1], key)
                    try:
                        os.symlink(member.linkname, parts[-1], dir_fd=parent)
                    finally:
                        os.close(parent)
                elif member.isfile():
                    require(len(parts) > 1 or parts[0] not in TREES, 'archive tree must be a directory: ' + key)
                    parent = open_directory(stage_fd, parts[:-1], key)
                    try:
                        fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                    finally:
                        os.close(parent)
                    with os.fdopen(fd, 'wb') as target, archive.extractfile(member) as source:
                        shutil.copyfileobj(source, target)
                        os.fchmod(target.fileno(), 0o600 | (member.mode & 0o100))
                else:
                    raise ValueError('archive hard links and special files are forbidden: ' + key)
    finally:
        os.close(stage_fd)
    manifest = json.loads((stage / 'manifest.json').read_text())
    require(manifest.get('schemaVersion') == 1, 'unsupported backup schema')
    require(manifest.get('environment') == name, 'backup environment does not match selected environment')
    require(manifest.get('mode') in ('live', 'consistent'), 'invalid backup mode')
    files, links = inventory(stage)
    files.pop('manifest.json', None)
    # Archives from before links were kept have no `links` and hold none.
    require(files == manifest.get('files') and links == manifest.get('links', {}), 'archive checksum validation failed')
    quick_check(stage / 'data/colloq.db')
    release = json.loads((stage / 'release.json').read_text())
    require(release['catalog'] == json.loads((stage / 'catalog.json').read_text()), 'catalog does not match release')
    require(release['dataSchemaVersion'] == manifest.get('dataSchemaVersion'), 'backup schema does not match release')
    return manifest


def sync_tree(root):
    report = Report(quiet=True)
    walk(root, report, lambda _parts, fd, _info: os.fsync(fd), lambda _parts, fd, _info, _path: os.fsync(fd), ignore,
         extra_depth=2)
    require(not report.skipped and not report.changed, 'restore stage contains a special file')
    sync_directory(root)


def chown_tree(root, uid, gid):
    """Hand a restored tree to the container user, links included, following none."""
    os.chown(root, uid, gid, follow_symlinks=False)
    walk(root, Report(quiet=True),
         lambda _parts, fd, _info: os.fchown(fd, uid, gid),
         lambda _parts, fd, _info, _path: os.fchown(fd, uid, gid),
         lambda parts, _target, _path: os.chown(root.joinpath(*parts), uid, gid, follow_symlinks=False),
         extra_depth=2)


def restore(args):
    root = Path(args.root).absolute()
    require(root != Path('/') and not root.is_symlink(), 'unsafe restore root')
    root.mkdir(parents=True, exist_ok=True)
    operation_lock(root)
    recovering = getattr(args, 'recover', False)
    marker = root / RESTORE_MARKER
    previous_marker = None
    if os.path.lexists(marker):
        require(recovering, 'interrupted restore exists; validate the same archive and rerun with --recover')
        require(not marker.is_symlink() and marker.is_file() and marker.stat().st_size < 65536, 'invalid restore marker')
        previous_marker = json.loads(marker.read_text())
        require(isinstance(previous_marker, dict) and previous_marker.get('schemaVersion') == 1 and
                isinstance(previous_marker.get('previousTrees'), list), 'invalid restore marker')
    else:
        require(not recovering, '--recover requires an interrupted restore marker')
    names = ('data', 'workspace', 'secrets', 'recovery', 'config.env')
    for name in names:
        target = root / name
        require(not target.is_symlink(), 'restore target symlink is forbidden')
        require(args.replace or recovering or not target.exists() or (target.is_dir() and not any(target.iterdir())),
                'restore target is not empty; use --replace to preserve previous trees for rollback')
    with tempfile.TemporaryDirectory(prefix='.restore-', dir=root) as directory:
        stage = Path(directory)
        archive_digest = digest(Path(args.archive))
        manifest = unpack(args.archive, stage, args.name)
        require(digest(Path(args.archive)) == archive_digest, 'archive changed during validation')
        if previous_marker is not None:
            require(previous_marker.get('archiveSha256') == archive_digest and previous_marker.get('environment') == args.name,
                    '--recover requires the same validated archive and environment as the interrupted restore')
        selected = json.loads(Path(args.release).read_text())
        require(manifest['dataSchemaVersion'] in selected.get('compatibleDataSchemaVersions', []),
                'selected release is incompatible with backup data schema')
        require_database_schema(stage / 'data/colloq.db', selected, 'this backup')
        # Preserve the backup release/catalog without changing operator-installed release state.
        (stage / 'recovery').mkdir()
        for name in ('manifest.json', 'release.json', 'catalog.json'):
            (stage / name).rename(stage / 'recovery' / name)
        for name in names:
            require((stage / name).exists(), 'missing required restore entry: ' + name)
        # Finish ownership before publishing the new trees or clearing the
        # marker. Root-installed data must already be readable by UID 1000.
        if os.geteuid() == 0:
            for name in ('data', 'workspace'):
                chown_tree(stage / name, 1000, 1000)
        sync_tree(stage)
        old = root / ('replaced-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
        old.mkdir(mode=0o700)
        # This fsynced marker precedes the FIRST destructive rename. Every
        # startup path refuses it, including after SIGKILL or host power loss.
        # Explicit recovery replays the validated archive, retaining both the
        # original prior trees and any mixed generation from the failed attempt.
        history = previous_marker['previousTrees'] if previous_marker else []
        require(len(history) < 100, 'too many interrupted recoveries; inspect retained trees manually')
        operation_state = dict(schemaVersion=1, archiveSha256=archive_digest,
            environment=args.name, previousTrees=history + [old.name], stagingTree=stage.name,
            dataSchemaVersion=manifest['dataSchemaVersion'], phase='swapping')
        write_restore_marker(root, operation_state)
        originals = {name: ((root / name).stat().st_dev, (root / name).stat().st_ino)
                     if (root / name).exists() else None for name in names}
        moved, installed = [], []
        try:
            for name in names:
                if (root / name).exists():
                    durable_rename(root / name, old / name)
                    moved.append(name)
                durable_rename(stage / name, root / name)
                installed.append(name)
        except BaseException:
            try:
                for name in reversed(installed):
                    durable_rename(root / name, stage / name)
                for name in reversed(moved):
                    durable_rename(old / name, root / name)
                # rename may have succeeded immediately before fsync raised,
                # before the bookkeeping list was updated. Never clear the
                # marker unless every original root entry is actually back.
                for name in names:
                    restored = ((root / name).stat().st_dev, (root / name).stat().st_ino) if (root / name).exists() else None
                    require(restored == originals[name], 'rollback incomplete; rerun validated restore with --recover')
            except BaseException:
                # A partial rollback is still unsafe to start. Retain marker.
                raise
            if previous_marker is None:
                clear_restore_marker(root)
            raise
        operation_state['phase'] = 'files-restored'
        write_restore_marker(root, operation_state)
        if not getattr(args, 'defer_finalize', False):
            clear_restore_marker(root)
        print('restored; previous trees retained at ' + str(old))


def finalize(args):
    """Finish after the shell has reset stale runtime reservations with writers stopped."""
    root = Path(args.root).absolute()
    require(root != Path('/') and not root.is_symlink(), 'unsafe restore root')
    operation_lock(root)
    marker = root / RESTORE_MARKER
    require(marker.is_file() and not marker.is_symlink() and marker.stat().st_size < 65536,
            'restore finalization requires a valid marker')
    state = json.loads(marker.read_text())
    require(state.get('schemaVersion') == 1 and state.get('phase') == 'files-restored',
            'restore files are not ready for finalization; rerun with --recover')
    require(state.get('archiveSha256') == digest(Path(args.archive)) and state.get('environment') == args.name,
            'restore finalization requires the original archive and environment')
    selected = json.loads(Path(args.release).read_text())
    recovered = json.loads((root / 'recovery/release.json').read_text())
    require(state.get('dataSchemaVersion') == recovered['dataSchemaVersion'] and
            recovered['dataSchemaVersion'] in selected.get('compatibleDataSchemaVersions', []),
            'restore finalization schema mismatch')
    require(not (root / 'data').is_symlink() and not (root / 'data/colloq.db').is_symlink(),
            'restore database path changed')
    quick_check(root / 'data/colloq.db')
    require_database_schema(root / 'data/colloq.db', selected, 'the restored data')
    clear_restore_marker(root)
    print('restore finalized; runtime reservations reset and writers remain stopped')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for command in ('backup', 'validate', 'restore', 'finalize', 'preflight'):
        p = commands.add_parser(command)
        p.add_argument('--name', default='')
        if command == 'validate':
            p.add_argument('--release')
        else:
            p.add_argument('--root', required=True)
            p.add_argument('--release', required=True)
        if command in ('backup', 'preflight'):
            p.add_argument('--output', required=True)
        else:
            p.add_argument('--archive', required=True)
        if command == 'backup':
            p.add_argument('--mode', choices=('live', 'consistent'), required=True)
            p.add_argument('--quiesced', action='store_true')
            p.add_argument('--brief', action='store_true', help='count skipped entries instead of naming them (the preflight named them)')
        if command == 'restore':
            p.add_argument('--replace', action='store_true')
            p.add_argument('--recover', action='store_true', help='replay the same validated archive after an interrupted restore')
            p.add_argument('--defer-finalize', action='store_true', help='keep startup blocked until runtime services are reset')
    p = commands.add_parser('prune', help='delete the oldest backups beyond --keep')
    p.add_argument('--directory', required=True)
    p.add_argument('--keep', type=int, required=True)
    p.add_argument('--fresh', required=True, help='the backup just made; never deleted')
    p = commands.add_parser('check-schema', help='refuse a release that does not list the database schema')
    p.add_argument('--root', required=True)
    p.add_argument('--release', required=True)
    args = parser.parse_args()
    if args.command == 'validate':
        with tempfile.TemporaryDirectory(prefix='colloq-verify-') as directory:
            stage = Path(directory)
            manifest = unpack(args.archive, stage, args.name)
            if args.release:
                selected = json.loads(Path(args.release).read_text())
                require(manifest['dataSchemaVersion'] in selected.get('compatibleDataSchemaVersions', []),
                        'selected release is incompatible with backup data schema')
                require_database_schema(stage / 'data/colloq.db', selected, 'this backup')
            summary = {k: v for k, v in manifest.items() if k not in ('files', 'links')}
            summary.update(fileCount=len(manifest['files']), linkCount=len(manifest.get('links', {})))
            print(json.dumps(summary))
    else:
        globals()[args.command.replace('-', '_')](args)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except (ValueError, OSError, sqlite3.Error, tarfile.TarError, KeyError) as error:
        print('recovery: ' + str(error), file=sys.stderr)
        sys.exit(1)
