"""Colloq — a collaborative environment for seminars.

The package holds no class logic: all of it is in the CLI, which lies next to
it prebuilt (_app/cli/colloq.mjs) and runs under Node. Here there is only the
packaging, the part that lets you install all of this with one line,
`pip install colloq`.

Entry point: colloq.__main__:main.
"""

from ._version import __version__

__all__ = ["__version__"]
