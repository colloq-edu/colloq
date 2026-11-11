import { build } from 'esbuild'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/** Keep Plotly's complete strict entry-point inventory, but register a trace
 * only when the figure uses it. The normal scatter graph never downloads the
 * map renderer, WebGL machinery, 3D geometry or any unrelated trace. */
export async function buildPlotly(outdir) {
  const require = createRequire(import.meta.url)
  const root = path.dirname(require.resolve('plotly.js/package.json'))
  const license = await fs.readFile(path.join(root, 'LICENSE'), 'utf8')
  const strict = await fs.readFile(path.join(root, 'lib/index-strict.js'), 'utf8')
  const traces = Object.fromEntries([...strict.matchAll(/require\('([^']+)'\)/g)]
    .filter(([, ref]) => !['./core', './calendars'].includes(ref))
    .map(([, ref]) => [ref.endsWith('/strict') ? ref.split('/').at(-2) : ref.slice(2),
      path.resolve(root, 'lib', ref + '.js')]))
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'colloq-plotly-'))
  try {
    const entry = path.join(await fs.realpath(temporary), 'plotly.min.js')
    await fs.writeFile(entry, `
      /*! ${license.trim()} */
      import Plotly from ${JSON.stringify(path.join(root, 'lib/core.js'))};
      import calendars from ${JSON.stringify(path.join(root, 'lib/calendars.js'))};
      Plotly.register(calendars);
      window.Plotly = Plotly;
      const loaders = {${Object.entries(traces).map(([name, file]) =>
        `${JSON.stringify(name)}:()=>import(${JSON.stringify(file)})`).join(',')}};
      const loading = new Map();
      export async function prepare(figure) {
        const wanted = new Set();
        // Type changes in frames and restyle buttons are part of the figure,
        // too. Traverse data only: no arbitrary URL ever becomes an import.
        const visit = (value, key) => {
          if (key === 'type' && typeof value === 'string' && Object.hasOwn(loaders, value)) wanted.add(value);
          if (Array.isArray(value)) for (const item of value) visit(item, key);
          else if (value && typeof value === 'object') {
            // Restyle accepts both [{type: 'bar'}] and ['type', 'bar'];
            // buttons default to restyle and can carry a second-click args2.
            if ((key === 'buttons' || key === 'steps') &&
                (value.method == null || value.method === 'restyle')) {
              for (const args of [value.args, value.args2]) {
                if (Array.isArray(args) && args[0] === 'type') visit(args[1], 'type');
              }
            }
            for (const [name, item] of Object.entries(value)) visit(item, name);
          }
        };
        visit(figure, '');
        await Promise.all([...wanted].map(name => {
          if (!loading.has(name)) loading.set(name, loaders[name]().then(module => {
            Plotly.register(module.default);
          }).catch(error => { loading.delete(name); throw error; }));
          return loading.get(name);
        }));
        return Plotly;
      }
    `)
    const result = await build({
      entryPoints: [entry], outdir, format: 'esm', splitting: true,
      bundle: true, minify: true, metafile: true, target: 'es2022',
      chunkNames: 'chunks/[name]-[hash]', loader: { '.glsl': 'text' },
      plugins: [{
        name: 'plotly-inline-css',
        setup(builder) {
          // A module import does not load esbuild's separate CSS output. Keep
          // upstream styles on their actual import edge, inside the sandbox:
          // the frame already permits inline styles and forbids remote data.
          // CSS bytes are now part of the measured JS graph, never discarded.
          builder.onLoad({ filter: /\.css$/ }, async ({ path: file }) => ({
            loader: 'js',
            contents: `const style = document.createElement('style');
              style.textContent = ${JSON.stringify(await fs.readFile(file, 'utf8'))};
              document.head.appendChild(style);`,
          }))
        },
      }],
      alias: { regl: '@plotly/regl', stream: 'stream-browserify' },
      define: { global: 'window', 'define.amd': 'false', 'process.env.NODE_DEBUG': 'false' },
      logLevel: 'warning',
    })
    const outputs = result.metafile.outputs
    if (Object.keys(outputs).some(file => file.endsWith('.css'))) {
      throw new Error('Plotly emitted an unattached stylesheet instead of an inline module')
    }
    await fs.writeFile(path.join(outdir, 'LICENSE'), license)
    const files = Object.keys(outputs)
    const entryOutput = files.find(file => path.resolve(outputs[file].entryPoint ?? '') === entry)
    if (!entryOutput) throw new Error('Plotly build did not emit its entry')
    const cold = new Set()
    const visit = file => {
      if (cold.has(file)) return
      cold.add(file)
      for (const dependency of outputs[file].imports) {
        if (dependency.kind === 'import-statement') visit(dependency.path)
      }
    }
    visit(entryOutput)
    const relative = file => path.relative(outdir, file).split(path.sep).join('/')
    const manifest = {
      version: 1, plotly: require('plotly.js/package.json').version,
      traces: ['scatter', ...Object.keys(traces)].sort(),
      files: files.map(relative).sort(), cold: [...cold].map(relative).sort(),
    }
    await fs.writeFile(path.join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    // Remove only obsolete generated artifacts from our own previous build.
    // A failed build leaves the previous build usable.
    const keep = new Set(manifest.files)
    const chunks = path.join(outdir, 'chunks')
    for (const file of await fs.readdir(chunks)) {
      if (/\.(?:js|css)(?:\.br|\.gz)?$/.test(file) && !keep.has('chunks/' + file.replace(/\.(?:br|gz)$/, ''))) {
        await fs.unlink(path.join(chunks, file))
      }
    }
    // Pre-inline builds emitted this entry CSS and one unused copy per trace.
    for (const suffix of ['', '.br', '.gz']) {
      await fs.rm(path.join(outdir, 'plotly.min.css' + suffix), { force: true })
    }
    return manifest
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = fileURLToPath(new URL('../public/plotly', import.meta.url))
  const manifest = await buildPlotly(out)
  console.log(`Built Plotly ${manifest.plotly}: ${manifest.traces.length} trace types, ${manifest.files.length} modules`)
}
