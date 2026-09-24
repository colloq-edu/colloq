# What we build on top of is a parameter, and that is the whole inheritance
# mechanism.
#
# The default parent is python-slim, that is, exactly the old build. But it
# can also be a ready colloq image (`--build-arg PARENT=colloq-kernel:base-gpu`),
# and then this very file builds not a base but a thin layer on top of it:
# torch with CUDA stays in the parent and is not installed again.
ARG PARENT=python:3.11-slim-bookworm
FROM ${PARENT}

# The parent may be our own image, and its last line is `USER runner`: as that
# user neither apt nor pip would get through. On python-slim this line changes
# nothing: it is root there anyway.
USER root

# There is NO MPLBACKEND here, and this is a fix made after a live seminar.
#
# There used to be `MPLBACKEND=Agg`: the variable applies to the whole
# container, the kernel included, and Agg draws into a file and hands nothing
# out. So `plt.show()` in a cell produced not a single display_data message:
# the plot did not appear, there was no error, the cell honestly reported
# "done". Checked on a live machine: with Agg the kernel answers with a single
# `stream`, without the variable with `display_data` carrying image/png.
#
# Unset, and rightly so: inside the kernel matplotlib picks the inline backend
# itself (matplotlib_inline comes with ipykernel), and in a plain
# `python script.py`, where there is no screen, the same Agg. Both sides get
# what they need without the variable; setting it globally means picking one
# of the two for both cases.
# PLOTLY_RENDERER, on the other hand, is set, and this fix is about exactly
# the same spot as the paragraph above.
#
# Without it plotly decides by itself how to hand out a figure, and decides
# differently in different versions: 7.x in ipykernel sends only
# `application/vnd.plotly.v1+json`, which the notebook draws the interactive
# chart from, while 5.x adds `text/html` with a script to it and with the
# first frame sends the WHOLE plotly.js bundle, five megabytes. Colloq never
# runs scripts from output (SECURITY.md), so those five megabytes are pure
# weight in the shared document, which goes to everyone in the room.
#
# `plotly_mimetype` is not a ban but a default: a student overrides it with
# the line `pio.renderers.default = "png"`, and that keeps working. The server
# sets the same variable when it starts a room container (kernel/pool.ts ·
# runArgs), for the sake of other environments built without this file.
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PLOTLY_RENDERER=plotly_mimetype

# Both steps below repeat on every layer of the chain, and that is cheap: on a
# ready parent curl is already installed (apt-get spends seconds on the indexes
# and answers "already the newest version"), and pip answers "Requirement
# already satisfied" to every line of the base and downloads nothing. Only what
# the parent lacks costs minutes, and that is what inheritance is for.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl libgomp1 \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# A seminar's environment is a layer on top of the base, not instead of it.
#
# Two layers rather than one, for the sake of the cache: the base is the same
# for all environments, so docker reuses it, and "create an environment" costs
# only the packages the base does not have. One shared layer would be rebuilt
# entirely on every edit of the list, and that means pandas and scikit-learn
# all over again.
#
# Exactly the chosen file is copied, not the whole folder: otherwise an edit
# of another environment would reset this one's cache.
ARG KERNEL_ENV=base
COPY environments/${KERNEL_ENV}.txt /tmp/environment.txt
RUN pip install --no-cache-dir -r /tmp/environment.txt

# Student code runs as this user; it owns nothing outside /workspace.
#
# Idempotent: on the second layer of the chain runner has already been created
# by the parent, and a second `useradd` fails with "already exists" and brings
# down the whole build.
RUN if ! id -u runner >/dev/null 2>&1; then useradd --create-home --uid 1000 runner; fi \
 && mkdir -p /workspace \
 && chown runner:runner /workspace
USER runner
WORKDIR /workspace

EXPOSE 8888
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=12 \
  CMD curl -fsS "http://localhost:8888/api/status?token=${JUPYTER_TOKEN}" || exit 1

CMD ["sh", "-c", "exec jupyter server \
  --ServerApp.ip=0.0.0.0 \
  --ServerApp.port=8888 \
  --ServerApp.root_dir=/workspace \
  --ServerApp.allow_remote_access=True \
  --ServerApp.allow_origin='*' \
  --ServerApp.disable_check_xsrf=True \
  --IdentityProvider.token=\"$JUPYTER_TOKEN\" \
  --no-browser"]
