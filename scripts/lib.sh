# Shared by the ops scripts. Not a program: it is sourced.
#
#   . ./scripts/lib.sh   from the repository root (host.sh, service.sh, vast.sh)
#   . ./lib.sh           from scripts/, with ENV_FILE named beforehand (dns.sh)
#
# Two things live here, and both are about the same file: where to look for
# the state directory (COLLOQ_STATE_ROOT, see below) and how to read a line
# from .env.
#
# Reading a line used to be copied word for word into three scripts, and all
# three carried the same bug: `tr -d ' \r'`, that is, "delete every space,
# wherever it stands". Card names in the vast API are written with a space
# ("RTX 4090"), and `VAST_GPU=RTX 4090` from .env turned into "RTX4090", for
# which the market has not a single offer; meanwhile the script advised
# writing into .env exactly what was already written there. The institution
# name, a path with a space, the relay name: the same story.
#
# Now there is one rule, and it is written once: only the edges are trimmed,
# quotes at the edges are removed as a pair, the way the server does it when
# reading PUBLIC_URL (server/src/config.ts). The inside of the value is not
# touched at all.

# The STATE root: .env, the receipt of the running class, .colloq.pid, data/.
#
# There are two roots, and they do not coincide everywhere. The APPLICATION
# directory is the one above scripts/: web/dist, kernel/, these very scripts.
# For colloq installed through pip it lies in <site-packages>/colloq/_app, is
# read-only and is wiped entirely by every `pip install -U`; the state lives
# separately, in ~/.colloq, and its address arrives here in the COLLOQ_HOME
# variable.
#
# The scripts, though, took themselves for the state root ("cd $(dirname
# $0)/.." in the header), and for installed colloq publishing "succeeded" into
# nowhere: PUBLIC_URL went into the .env of the application directory, which
# nobody reads, while `colloq link` looked into <home>/.env and kept saying
# "not exposed to the outside".
#
# Without COLLOQ_HOME it is exactly as before: the current directory, that is,
# the very directory above scripts/ that the script has already moved into on
# its own. In the repository both roots are that directory, so not a single
# path moved there.
COLLOQ_STATE_ROOT="${COLLOQ_HOME:-.}"

# The settings file. The scripts work from the repository root, dns.sh from
# scripts/, and its path is different; there is no other difference between
# them.
ENV_FILE="${ENV_FILE:-$COLLOQ_STATE_ROOT/.env}"

# read_env NAME: the value of the line `NAME=…` from .env, an empty string if
# there is none. The last one is taken: what was appended to the end of the
# file wins, and the server looks at it the same way.
read_env() {
  local v
  v="$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  # CRLF: a .env that has been through Windows would otherwise bring a carriage
  # return into a container name and an address.
  v="${v%$'\r'}"
  # Spaces and tabs at the edges, and only at the edges.
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  # Quotes are removed only as a pair: a single quote inside the value is part
  # of the value, not half of a wrapper.
  case "$v" in
    '"'*'"') v="${v#\"}"; v="${v%\"}" ;;
    "'"*"'") v="${v#\'}"; v="${v%\'}" ;;
  esac
  printf '%s' "$v"
}
