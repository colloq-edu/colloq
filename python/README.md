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

- **Docker** — the room's Python lives in it. The kernel image is built here,
  from the Dockerfile that shipped with the package.

That is all on macOS 14+ and on Linux x64/arm64 (glibc 2.28+): pip installs a
wheel for the platform with Node.js and the server's dependencies inside.

Elsewhere (macOS 13, Alpine, other architectures) pip installs the universal
wheel, which also needs **Node.js 22 or newer**. `colloq` finds it on its own,
including under nvm, fnm, volta and asdf, and says so in words if Node is
missing. On the first run it installs the server's dependencies once
(`npm install --omit=dev` inside its own directory) and says so out loud.

## Where your things live

State lives in `~/.colloq`, never inside the package: `.env`, the database,
`workspace/`, and any environments you create. Reinstalling or upgrading the
package leaves all of it alone. Point `COLLOQ_HOME` elsewhere to move it.

```
colloq start            # a class on this machine
colloq start --share    # the same, plus one public link for your students
colloq host <name>      # publish a running class under your own name
colloq status           # what is running here, no network calls
colloq doctor           # check everything before the lecture
colloq env new <name>   # a Python environment of your own
colloq stop             # end the class
```

`colloq --help` lists the rest; `colloq <command> --help` explains one.

## One link for the class

```
colloq start --share
```

starts the class, opens a quick Cloudflare tunnel and prints one block: the
link to give your students (`https://….trycloudflare.com/s/<class>`), or — if
there is no class yet — where to create one; the class links in the panel's
list already use the public address. The link lives while this terminal is
open, and `Ctrl+C` closes it together with the class. A quick tunnel gets a new
address on every start, so send the new link each time. Never share a link
with `/admin/` in it: that is a key to the panel.

The first `--share` downloads `cloudflared` if it is not installed: a pinned
release from `github.com/cloudflare/cloudflared`, checked against a pinned
SHA-256 before it is ever run, kept in `~/.colloq/bin`. `COLLOQ_CLOUDFLARED=/path`
uses your own file instead; `COLLOQ_CLOUDFLARED_DOWNLOAD=0` forbids the
download. macOS and Linux only; on Windows, use WSL 2.

Cloudflare addresses do not open from Russia. For students there, publish
through your own relay instead: `colloq start --host <name>` with the `RELAY_*`
lines in `~/.colloq/.env`.

## Boundaries

A class runs **on this computer, for your own students**: the server listens on
the loopback interface, and only an explicit `--share`, `--host` or
`colloq host` lets an audience in from outside. Each room's Python runs in a
hardened container of its own, cut off from your home network — and a class is
published only when that is true: if the kernels do not run one container per
room in Docker, publishing refuses and the class stays local. What remains
true is that the link is a door: anyone who has it runs code in a sandbox on
this computer. Keep it for your class; for an open audience, run the server
installation on a machine of its own.

## Where this comes from

The package is built from the Colloq repository with `make wheel`. Inside it is
the built application — server, frontend, CLI, kernel Dockerfile; the Python
code here is packaging and nothing more, finding Node and handing over control.

MIT.
