import { mount } from 'svelte'
import './index.css'
import { initializeLanguage, onLanguageChange } from './lib/i18n.svelte'
import { firstScreenReady, whenFirstScreen } from './lib/boot'
import { tr } from '@shared/i18n'

const target = document.getElementById('root')
if (!target) throw new Error('Colloq: #root is missing from index.html')

function updateBootLanguage(): void {
  document.getElementById('boot')?.setAttribute('aria-label', tr('common.loadingApp'))
}
updateBootLanguage()
const stopBootLanguage = onLanguageChange(updateBootLanguage)

/**
 * The built stylesheet is loaded non-blockingly (see vite.config.ts) so the
 * inlined shell can paint with zero network. The cost is that the app can mount
 * before its CSS has applied, so the shell — which is covering an undressed
 * document until then — leaves on the stylesheet, not on the mount.
 *
 * We wait for the APPLIED sheet (`link.sheet`), not for the load event. The
 * link now travels as `rel=preload as=style` — that way the browser gives it
 * high priority — and its `load` fires on the downloaded bytes, before the
 * inline handler switches it to `rel=stylesheet` and the sheet lands in the
 * document. Leaving on that event would mean showing the app undressed for a
 * frame.
 */
const STYLE_WAIT = 2000

function stylesApplied(): Promise<void> {
  const sheets = [...document.querySelectorAll<HTMLLinkElement>('link[data-colloq-css]')]
  const failed = new Set<HTMLLinkElement>()
  const ready = () => sheets.every((link) => link.sheet !== null || failed.has(link))
  if (ready()) return Promise.resolve()

  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const check = () => {
      if (settled) return
      if (ready()) finish()
      else requestAnimationFrame(check)
    }
    for (const link of sheets) {
      link.addEventListener('load', check)
      link.addEventListener('error', () => {
        failed.add(link)
        check()
      })
    }
    requestAnimationFrame(check)
    // A stylesheet that never arrives must not hold the seminar hostage. Not
    // a single frame is normally spent here — so if we got here, the
    // deployment is broken, and it must not go unmentioned: the app is about
    // to be shown undressed, and it is on us, not the user, to explain that
    // in the console.
    setTimeout(() => {
      if (settled) return
      console.warn('Colloq: styles did not apply within 2 s — the shell leaves without them')
      finish()
    }, STYLE_WAIT)
  })
}

function dismissShell(): void {
  stopBootLanguage()
  const shell = document.getElementById('boot')
  if (!shell) return
  shell.dataset.leaving = ''
  const drop = () => shell.remove()
  shell.addEventListener('transitionend', drop, { once: true })
  // A backgrounded tab never fires transitionend, and this must not linger.
  setTimeout(drop, 400)
}

/**
 * A chunk of the app did not arrive — say so once and offer a way out.
 *
 * Screens, highlighting, the reader and the output renderers live in
 * separate files and load on first demand. Retrying is possible now (a
 * failure is no longer cached), but that does not cure a redeploy under an
 * open tab: the file with the old name is gone from the server, and the
 * server answers any path with index.html — the import fails parsing HTML as
 * a module, and it always will. Only a reload cures it, while the tab looks
 * alive: a cell just is not highlighted, a note's markup stays plain text,
 * and a PDF does not open.
 *
 * We cancel nothing (`preventDefault` would make Vite hand the import
 * `undefined` instead of a failure): there is only a bar over the screen.
 */
const MODULE_LOAD_FAILURE = /dynamically imported module|Importing a module script failed/i

let offered = false

function offerReload(): void {
  if (offered) return
  offered = true
  // There is no point staying under a splash that will wait for nothing: a
  // chunk of the screen did not arrive, and however long you wait, it will
  // not. The shell leaves, and the bar with "Reload" is in plain view rather
  // than on top of a loading promise.
  firstScreenReady()
  const bar = document.createElement('div')
  bar.setAttribute('role', 'alert')
  bar.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:16px',
    'transform:translateX(-50%)',
    'z-index:1000',
    'display:flex',
    'align-items:center',
    'gap:12px',
    'max-width:min(560px, calc(100vw - 32px))',
    'padding:10px 12px',
    'border:1px solid var(--boot-line)',
    'background:var(--boot-canvas)',
    'color:var(--boot-ink)',
    'font-family:inherit',
    'font-size:13px',
    'line-height:1.4',
    'box-shadow:0 6px 24px rgba(0,0,0,.18)',
  ].join(';')

  const text = document.createElement('span')
  text.textContent = tr('common.moduleLoadFailed')
  const again = document.createElement('button')
  again.type = 'button'
  again.textContent = tr('common.reload')
  onLanguageChange(() => {
    text.textContent = tr('common.moduleLoadFailed')
    again.textContent = tr('common.reload')
  })
  again.style.cssText = [
    'flex:none',
    'padding:6px 12px',
    'border:1px solid var(--boot-accent)',
    'background:var(--boot-accent)',
    'color:#fff',
    'font-family:inherit',
    'font-size:13px',
    'font-weight:600',
    'cursor:pointer',
  ].join(';')
  again.addEventListener('click', () => location.reload())

  bar.append(text, again)
  document.body.append(bar)
}

// Vite sends its own event from the preload helper — before the failure
// reaches the importer, and whether or not the importer catches it.
window.addEventListener('vite:preloadError', offerReload)
// And an import without the helper (and anything that surfaces "at the
// top") is visible only this way.
window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason
  const said = reason instanceof Error ? reason.message : String(reason ?? '')
  if (MODULE_LOAD_FAILURE.test(said)) offerReload()
})

void (async () => {
  // The form's code can travel while we read the instance language. Mounting
  // still waits for both so the first interactive frame uses that language.
  const [, { default: App }] = await Promise.all([
    initializeLanguage(),
    import('./App.svelte'),
  ])
  mount(App, { target })
  await stylesApplied()
  // Give the styled join form a frame before using spare bandwidth for the
  // room. The build's head listener only preloads modules; their evaluation
  // still waits for entry. A saved identity already warmed them in the head.
  //
  // It comes BEFORE waiting for the first screen, although the shell is still
  // in place: the event says "the form is drawn", not "the splash is gone",
  // and holding it back until the wait is over would rob a cold entry into
  // the room of the whole head start it exists for.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => window.dispatchEvent(new Event('colloq:ready')))
  })
  /*
   * And only now is the shell removed.
   *
   * A mounted App is not yet a screen: at this moment, under the shell there
   * is an `{#await}` over the route chunk and empty `session`/`adminAuth`.
   * Leaving here, the splash uncovered a skeleton — the gray layout of a
   * screen nothing is known about yet. We wait until the first screen has
   * something to show (lib/boot.ts), and no longer than the cap: after that
   * the same app splash takes the place of the data, at the same
   * coordinates.
   */
  await whenFirstScreen()
  /*
   * A frame to paint what was reported: `firstScreenReady` is called from an
   * effect, that is, after the DOM edit but before it is shown. Without this
   * pause the empty ground managed to flash between the leaving shell and
   * the ready screen.
   *
   * With a backup alarm: a background tab produces no frames at all, and
   * there is nothing to wait for there — nobody sees the shell anyway, and it
   * must not hang around until the tab is visited again.
   */
  await new Promise<void>((paint) => {
    requestAnimationFrame(() => paint())
    setTimeout(paint, 100)
  })
  dismissShell()
})().catch(offerReload)
