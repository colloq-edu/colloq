#!/usr/bin/env python3
"""Portable application recovery. No cluster credentials are stored in the archive.

The shell wrapper owns writer quiescence. A live backup is SQLite-consistent but
its filesystem files are copied at different instants. Checksums detect damage,
not a maliciously replaced backup: keep archives private and trusted.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import stat
import sys
import tarfile
import tempfile

RESTORE_MARKER = '.restore-in-progress'


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


def sync_tree(root):
    for directory, _, files in os.walk(root, topdown=False, followlinks=False):
        for name in files:
            fd = os.open(Path(directory) / name, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                require(stat.S_ISREG(os.fstat(fd).st_mode), 'restore stage contains a special file')
                os.fsync(fd)
            finally:
                os.close(fd)
        sync_directory(directory)


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


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def quick_check(path):
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
        require(db.execute('PRAGMA quick_check').fetchall() == [('ok',)], 'SQLite quick_check failed')


def copy_tree(source, destination, skip=()):
    require(not source.is_symlink(), 'symlink is not allowed: ' + str(source))
    if not source.exists():
        destination.mkdir(parents=True, exist_ok=True)
        return
    # Pin each opened directory/file by descriptor. Student processes can mutate
    # workspace names during live backup; a symlink swap must not make root read
    # outside the selected tree between the stat and the copy.
    def copy_fd(directory_fd, target_directory, excluded=()):
        target_directory.mkdir(parents=True, exist_ok=True)
        for name in os.listdir(directory_fd):
            if name in excluded:
                continue
            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            require(not stat.S_ISLNK(info.st_mode), 'symlink is not allowed: ' + name)
            require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), 'special file is not allowed: ' + name)
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if stat.S_ISDIR(info.st_mode):
                flags |= os.O_DIRECTORY
            opened = os.open(name, flags, dir_fd=directory_fd)
            try:
                actual = os.fstat(opened)
                if stat.S_ISDIR(actual.st_mode):
                    copy_fd(opened, target_directory / name)
                else:
                    require(stat.S_ISREG(actual.st_mode), 'special file is not allowed: ' + name)
                    with os.fdopen(os.dup(opened), 'rb') as source_file, (target_directory / name).open('xb') as target_file:
                        shutil.copyfileobj(source_file, target_file)
                    (target_directory / name).chmod(0o600 | (actual.st_mode & 0o100))
            finally:
                os.close(opened)
    directory_fd = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        copy_fd(directory_fd, destination, skip)
    finally:
        os.close(directory_fd)


def backup(args):
    require(args.mode != 'consistent' or args.quiesced, 'consistent backup requires --quiesced after stopping every writer')
    root = Path(args.root).resolve()
    operation_lock(root)
    require(not os.path.lexists(root / RESTORE_MARKER), 'interrupted restore must be recovered before backup')
    require((root / 'data/colloq.db').is_file(), 'application database is missing')
    require(not (root / 'data/colloq.db').is_symlink(), 'database symlink is not allowed')
    release = json.loads(Path(args.release).read_text())
    output = Path(args.output).absolute()
    require(not output.exists(), 'backup output already exists')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.colloq-backup-', dir=output.parent) as directory:
        stage = Path(directory)
        copy_tree(root / 'data', stage / 'data', ('colloq.db', 'colloq.db-wal', 'colloq.db-shm'))
        copy_tree(root / 'workspace', stage / 'workspace')
        copy_tree(root / 'secrets', stage / 'secrets')
        config = root / 'config.env'
        require(not config.is_symlink(), 'configuration symlink is not allowed')
        if config.is_file():
            shutil.copy2(config, stage / 'config.env')
        else:
            (stage / 'config.env').touch(mode=0o600)
        with sqlite3.connect((root / 'data/colloq.db').as_uri() + '?mode=ro', uri=True) as source:
            with sqlite3.connect(stage / 'data/colloq.db') as target:
                source.backup(target)
        quick_check(stage / 'data/colloq.db')
        (stage / 'release.json').write_text(json.dumps(release, indent=2) + '\n')
        (stage / 'catalog.json').write_text(json.dumps(release['catalog'], indent=2) + '\n')
        files = {str(p.relative_to(stage)): digest(p) for p in sorted(stage.rglob('*')) if p.is_file()}
        manifest = dict(schemaVersion=1, environment=args.name, mode=args.mode,
                        createdAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),
                        fileConsistency='stopped-writers' if args.mode == 'consistent' else 'files-copied-at-different-instants',
                        dataSchemaVersion=release['dataSchemaVersion'], files=files)
        (stage / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        temporary = stage / 'archive.tar.gz'
        with tarfile.open(temporary, 'w:gz') as archive:
            for name in ('manifest.json', 'release.json', 'catalog.json', 'config.env', 'data', 'workspace', 'secrets'):
                archive.add(stage / name, arcname=name)
        temporary.chmod(0o600)
        # Never replace an existing backup, even if a second process won the race.
        os.link(temporary, output)
    print(str(output))


def unpack(archive_path, stage, name):
    with tarfile.open(archive_path, 'r:gz') as archive:
        members = archive.getmembers()
        seen = set()
        for member in members:
            path = PurePosixPath(member.name)
            require(not path.is_absolute() and '..' not in path.parts and path.parts and
                    path.parts[0] in ('data', 'workspace', 'secrets', 'release.json', 'catalog.json', 'manifest.json', 'config.env'),
                    'unsafe archive path')
            require(member.name not in seen, 'duplicate archive path')
            seen.add(member.name)
            require(member.isfile() or member.isdir(), 'archive links and special files are forbidden')
            destination = stage.joinpath(*path.parts)
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, destination.open('xb') as target:
                    shutil.copyfileobj(source, target)
                destination.chmod(0o600 | (member.mode & 0o100))
    manifest = json.loads((stage / 'manifest.json').read_text())
    require(manifest.get('schemaVersion') == 1, 'unsupported backup schema')
    require(manifest.get('environment') == name, 'backup environment does not match selected environment')
    require(manifest.get('mode') in ('live', 'consistent'), 'invalid backup mode')
    actual = {str(p.relative_to(stage)): digest(p) for p in stage.rglob('*') if p.is_file() and p != stage / 'manifest.json'}
    require(actual == manifest.get('files'), 'archive checksum validation failed')
    quick_check(stage / 'data/colloq.db')
    release = json.loads((stage / 'release.json').read_text())
    require(release['catalog'] == json.loads((stage / 'catalog.json').read_text()), 'catalog does not match release')
    require(release['dataSchemaVersion'] == manifest.get('dataSchemaVersion'), 'backup schema does not match release')
    return manifest


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
                for current, directories, files in os.walk(stage / name, followlinks=False):
                    os.chown(current, 1000, 1000)
                    for item in files:
                        os.chown(Path(current) / item, 1000, 1000, follow_symlinks=False)
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
    clear_restore_marker(root)
    print('restore finalized; runtime reservations reset and writers remain stopped')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for command in ('backup', 'validate', 'restore', 'finalize'):
        p = commands.add_parser(command)
        p.add_argument('--name', default='')
        if command != 'validate':
            p.add_argument('--root', required=True)
            p.add_argument('--release', required=True)
        else:
            p.add_argument('--release')
        if command == 'backup':
            p.add_argument('--output', required=True)
            p.add_argument('--mode', choices=('live', 'consistent'), required=True)
            p.add_argument('--quiesced', action='store_true')
        else:
            p.add_argument('--archive', required=True)
        if command == 'restore':
            p.add_argument('--replace', action='store_true')
            p.add_argument('--recover', action='store_true', help='replay the same validated archive after an interrupted restore')
            p.add_argument('--defer-finalize', action='store_true', help='keep startup blocked until runtime services are reset')
    args = parser.parse_args()
    if args.command == 'validate':
        with tempfile.TemporaryDirectory(prefix='colloq-verify-') as directory:
            manifest = unpack(args.archive, Path(directory), args.name)
            if args.release:
                selected = json.loads(Path(args.release).read_text())
                require(manifest['dataSchemaVersion'] in selected.get('compatibleDataSchemaVersions', []),
                        'selected release is incompatible with backup data schema')
            print(json.dumps({k: v for k, v in manifest.items() if k != 'files'}))
    else:
        globals()[args.command](args)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        main()
    except (ValueError, OSError, sqlite3.Error, tarfile.TarError, KeyError) as error:
        print('recovery: ' + str(error), file=sys.stderr)
        sys.exit(1)
