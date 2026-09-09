import { mount } from 'svelte'
import './index.css'
import { initializeLanguage, onLanguageChange } from './lib/i18n.svelte'
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
 */
function stylesApplied(): Promise<void> {
  const pending = [...document.querySelectorAll<HTMLLinkElement>('link[data-colloq-css]')].filter(
    (link) => !link.sheet,
  )
  if (pending.length === 0) return Promise.resolve()

  return new Promise((resolve) => {
    let waiting = pending.length
    const settle = () => {
      if (--waiting === 0) resolve()
    }
    for (const link of pending) {
      link.addEventListener('load', settle, { once: true })
      link.addEventListener('error', settle, { once: true })
    }
    // A stylesheet that never arrives must not hold the seminar hostage.
    setTimeout(resolve, 2000)
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
 * Кусок приложения не приехал — сказать об этом один раз и предложить выход.
 *
 * Экраны, подсветка, читалка и рендереры вывода лежат отдельными файлами и
 * грузятся по первому требованию. Повторить попытку теперь можно (отказ больше
 * не кешируется), но редеплой под открытой вкладкой этим не лечится: файла с
 * прежним именем на сервере уже нет, а на любой путь сервер отдаёт index.html —
 * импорт падает на разборе HTML как модуля, и так будет всегда. Лечит только
 * перезагрузка, а вкладка при этом выглядит живой: просто ячейка не
 * подсвечивается, разметка заметки остаётся текстом, а PDF не открывается.
 *
 * Ничего не отменяем (`preventDefault` заставил бы Vite отдать в импорт
 * `undefined` вместо отказа): здесь только строка поверх экрана.
 */
const MODULE_LOAD_FAILURE = /dynamically imported module|Importing a module script failed/i

let offered = false

function offerReload(): void {
  if (offered) return
  offered = true
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

// Своё событие Vite шлёт из помощника предзагрузки — до того, как отказ дойдёт
// до того, кто импортировал, и независимо от того, поймает ли он его.
window.addEventListener('vite:preloadError', offerReload)
// А импорт без помощника (и любой пойманный «наверху») виден только так.
window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason
  const said = reason instanceof Error ? reason.message : String(reason ?? '')
  if (MODULE_LOAD_FAILURE.test(said)) offerReload()
})

void (async () => {
  await initializeLanguage()
  const { default: App } = await import('./App.svelte')
  mount(App, { target })
  await stylesApplied()
  dismissShell()
})().catch(offerReload)
