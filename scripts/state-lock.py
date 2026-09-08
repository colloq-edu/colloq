#!/usr/bin/env python3
"""One reentrant flock for Colloq deployment, writer quiescence and recovery.

Shell entry points first invoke `held --state DIR`, otherwise exec
`run --state DIR -- bash SCRIPT ORIGINAL_ARGS...`. The inherited descriptor is
verified against the current lock inode and flocked; an environment flag alone
cannot bypass exclusion. Nested commands never unlock their parent's descriptor.
"""
import argparse
import fcntl
import os
from pathlib import Path
import stat
import sys

VARIABLE = 'COLLOQ_STATE_LOCK_FD'


def lock_path(state):
    root = Path(state).absolute()
    if root.is_symlink() or root == Path('/'):
        raise ValueError('unsafe operation state directory')
    return root / '.operation.lock'


def inherited(state):
    try:
        raw = os.environ.get(VARIABLE, '')
        if not raw.isdecimal() or not 3 <= int(raw) <= 65535:
            return None
        fd = int(raw)
        actual = os.fstat(fd)
        expected = os.stat(lock_path(state), follow_symlinks=False)
        if (not stat.S_ISREG(actual.st_mode) or not stat.S_ISREG(expected.st_mode) or
                (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino)):
            return None
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except (OSError, ValueError):
        return None


def acquire(state):
    existing = inherited(state)
    if existing is not None:
        return existing
    target = lock_path(state)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(target, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        actual, expected = os.fstat(fd), os.stat(target, follow_symlinks=False)
        if not stat.S_ISREG(actual.st_mode) or (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino):
            raise ValueError('operation lock is not the expected regular file')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BaseException:
        os.close(fd)
        raise
    os.set_inheritable(fd, True)
    os.environ[VARIABLE] = str(fd)
    return fd


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('held', 'run'))
    parser.add_argument('--state', required=True)
    # parse_known_args leaves the command verbatim after --; options belonging
    # to the launched command must never be interpreted as launcher settings.
    args, command = parser.parse_known_args()
    if args.action == 'held':
        return 0 if inherited(args.state) is not None else 1
    if command[:1] == ['--']:
        command = command[1:]
    if not command:
        parser.error('run requires -- COMMAND [ARGS...]')
    acquire(args.state)
    os.execvpe(command[0], command, os.environ)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print('operation lock: another operation is active or the lock is invalid: ' + str(error), file=sys.stderr)
        sys.exit(75)
