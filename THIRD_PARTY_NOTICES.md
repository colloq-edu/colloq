# Third-party notices

Colloq's own code is licensed under the [MIT License](LICENSE). This repository
and everything built from it also contain third-party work under other licenses:

- the web bundle (`web/dist`);
- the server bundle;
- the Docker images;
- the pip wheel;
- the colloq.ru site.

This file lists the assets that are committed to the repository and the
non-MIT components that ship in the builds.

## Fonts committed to the repository

### JetBrains Mono: SIL Open Font License 1.1

Copyright 2020 The JetBrains Mono Project Authors
(<https://github.com/JetBrains/JetBrainsMono>).

| Files | License text |
| --- | --- |
| `web/public/fonts/jetbrains-mono-*.woff2` | `web/public/fonts/JetBrainsMono-OFL.txt` |
| `site/fonts/jetbrains-mono-*.woff2` | `site/fonts/JetBrainsMono-OFL.txt` |
| `server/assets/fonts/JetBrainsMono-Medium.ttf` (link-preview cards) | `server/assets/fonts/JetBrainsMono-OFL.txt` |

### HSE Sans: not covered by the MIT license

| Files |
| --- |
| `web/public/fonts/hse-sans-{400,600,700,900}.woff2` |
| `site/fonts/hse-sans-{400,600,700,900}.woff2` |
| `server/assets/fonts/HSESans-{Regular,Bold,Black}.otf` |

HSE Sans is the corporate typeface of HSE University (National Research
University Higher School of Economics). It is **not** covered by this project's
MIT license, and this repository grants no rights to it: the files are here only
to render Colloq's own interface. Do not reuse them outside Colloq. A fork that
needs a freely licensed typeface can swap these files and the `@font-face`
rules in `web/index.html`, `site/styles.css` and `docs/build.py`; the font stacks
already fall back to system fonts.

## Other assets committed to the repository

### pdf.js worker: Apache License 2.0

`web/public/pdf/pdf.worker.min.mjs` is copied unmodified from `pdfjs-dist`
6.2.108 by `npm run pdf:worker` (Copyright Mozilla Foundation). The file keeps
its license header. License: <https://www.apache.org/licenses/LICENSE-2.0>.

### plotly.js strict bundle: MIT

`web/public/plotly/plotly.min.js` is copied unmodified from
`plotly.js-strict-dist-min` 4.1.1 by `npm run plotly:dist` (Copyright Plotly,
Inc.) and keeps its license header. It is **not** committed — the copy step runs
on every build, and the file is ignored in `.gitignore`. The strict bundle is the
one without function constructors, so the sandboxed frame that renders a figure
needs no `unsafe-eval` in its policy (`server/src/plotly-frame.ts`).

## Components shipped in builds under non-MIT licenses

npm installs these; they are not committed. Each package carries its own license
file in `node_modules`, and the Docker images and a pip installation contain
them there.

| Component | License | Where it ends up |
| --- | --- | --- |
| `pdfjs-dist` | Apache-2.0 | web bundle (PDF viewer) |
| `dompurify` | MPL-2.0 OR Apache-2.0 | web bundle (HTML sanitising) |
| `satori` | MPL-2.0 | server (link-preview cards) |
| `@resvg/resvg-js` and its platform binaries | MPL-2.0 | server (link-preview cards) |
| `openai` | Apache-2.0 | server (Oracle) |
| `dotenv`, `webidl-conversions` | BSD-2-Clause | server |
| `qs`, `ieee754` | BSD-3-Clause | server |

Every other runtime npm dependency is MIT or ISC, per `package-lock.json`.
The KaTeX fonts in the web bundle are part of KaTeX (MIT).

## The vast.ai image

`deploy/vast/Dockerfile` adds prebuilt binaries to the Node base image. The
versions and checksums of `frpc` and `cloudflared` are pinned in that file:

| Component | License | Source |
| --- | --- | --- |
| `frpc` (frp) | Apache-2.0 | <https://github.com/fatedier/frp> |
| `cloudflared` | Apache-2.0 | <https://github.com/cloudflare/cloudflared> |
| Docker CLI and `docker-buildx` | Apache-2.0 | copied from the official `docker:*-cli` image |

The Debian packages installed with `apt-get` (`tini`, `curl`, `sqlite3`,
`procps`) and those of the `node:22-bookworm-slim` base keep their copyright
files under `/usr/share/doc` in the image.

## Kernel images

Room kernel images install Python packages from PyPI at build time:

- `kernel/requirements.txt`: Jupyter Server, ipykernel, NumPy, pandas,
  Matplotlib, Plotly, scikit-learn, requests and Black;
- `kernel/environments/*.txt`, for example seaborn, PyTorch (the CPU build in
  `cv`, the CUDA build in `base-gpu`), torchvision, timm, OpenCV and
  Transformers.

Each package keeps its own license inside the image. The CUDA build of PyTorch
brings NVIDIA CUDA libraries, which are covered by NVIDIA's license terms.
