# Public documentation

The Russian guides are plain HTML served at `https://colloq.ru/docs/` by the existing GitHub Pages workflow. They need no Node.js runtime, JavaScript build, external CDN, or client router. Search, code copying, and mobile navigation progressively enhance ordinary HTML navigation.

The authoritative article content and shared HTML template live in `docs/build.py`. Edit them there, then regenerate all 18 guides and the search index using the Python standard library:

```sh
python3 docs/build.py
```

Commit the generated HTML and `search-index.json` with the source change. Styles and browser behavior live in `site/docs/docs.css` and `site/docs/docs.js`; they reuse the landing page's local fonts and palette.

For local preview, from the repository root:

```sh
python3 -m http.server 8766 --bind 127.0.0.1 --directory site
```

Open `http://127.0.0.1:8766/docs/`. Preview through HTTP; `file://` does not provide the same search fetch or root-relative font paths.

Keep claims aligned with `shared/rules.ts`, `shared/publish.ts`, room/admin components, runtime/deployment scripts, and verified deployment records. A successful static-site check is not a VM, networking, backup, or GPU readiness claim. A release bundle does not contain the complete source checkout or its Makefile.
