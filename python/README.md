# colloq

A shared workspace for teaching: one link, one live notebook, one assistant.
Everything runs on the teacher's own machine — no cloud, no third-party server.

```
pip install colloq
colloq start
```

The first command installs the program, the second brings a class up and opens
your browser. `Ctrl+C` saves and stops it.

Bare `colloq` starts nothing: it prints three lines about what lives here. A
class takes a port and opens a window, and that should not happen because
somebody typed a word at a guess — which is exactly why `jupyter` on its own
prints help too, and `jupyter lab` is what starts a server.

## What the machine needs

- **Node.js 20 or newer** — the server and the CLI run on it. `colloq` finds it
  on its own, including under nvm, fnm, volta and asdf; if Node is missing, it
  says so in words.
- **Docker** — the room's Python lives in it. The kernel image is built here,
  from the Dockerfile that shipped with the package.

On the first run `colloq` installs the server's dependencies once (`npm install
--omit=dev` inside its own directory) and says so out loud. They are kept out of
the package deliberately: two of them are native, and a wheel carrying them
would be one wheel per «operating system + Node ABI» pair instead of one for
everyone.

## Where your things live

State lives in `~/.colloq`, never inside the package: `.env`, the database,
`workspace/`, and any environments you create. Reinstalling or upgrading the
package leaves all of it alone. Point `COLLOQ_HOME` elsewhere to move it.

```
colloq start            # a class on this machine
colloq host <name>      # publish it and hand the room a link
colloq status           # what is running here, no network calls
colloq doctor           # check everything before the lecture
colloq env new <name>   # a Python environment of your own
colloq stop             # end the class
```

`colloq --help` lists the rest; `colloq <command> --help` explains one.

## Boundaries

A class runs **on this computer, for your own students**: the server listens on
the loopback interface, each room's Python runs in its own container, and an
explicit command is what lets an audience in from outside. The hardening a
public service needs is not here — and that is said plainly rather than implied.
For an open audience, run the server installation on a machine of its own.

## Where this comes from

The package is built from the Colloq repository with `make wheel`. Inside it is
the built application — server, frontend, CLI, kernel Dockerfile; the Python
code here is packaging and nothing more, finding Node and handing over control.

MIT.
