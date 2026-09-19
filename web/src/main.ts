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
 * Ждём ПРИМЕНЁННЫЙ лист (`link.sheet`), а не событие загрузки. Ссылка теперь
 * едет как `rel=preload as=style` — так браузер даёт ей высокий приоритет, —
 * и её `load` срабатывает на скачанных байтах, до того как встроенный
 * обработчик переведёт её в `rel=stylesheet` и лист встанет в документ. Уйти
 * по такому событию значило бы показать приложение раздетым на кадр.
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
    // A stylesheet that never arrives must not hold the seminar hostage. Ни
    // одного кадра в норме здесь не бывает — поэтому, если сюда дошли, это
    // поломка выкладки, и молчать о ней нельзя: приложение сейчас покажут
    // раздетым, и объяснить это в консоли обязаны мы, а не пользователь.
    setTimeout(() => {
      if (settled) return
      console.warn('Colloq: стили не применились за 2 с — оболочка уходит без них')
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
  // Под заставкой, которая больше ничего не дождётся, стоять нечему: кусок
  // экрана не доехал, и сколько ни жди — не доедет. Оболочка уходит, и строка
  // с «Обновить» оказывается на виду, а не поверх обещания загрузки.
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
  // Стоит ПЕРЕД ожиданием первого экрана, хотя оболочка ещё на месте: событие
  // говорит «форма отрисована», а не «заставки больше нет», и придерживать его
  // до конца ожидания значило бы отнять у холодного входа в комнату всю ту
  // фору, ради которой оно заведено.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => window.dispatchEvent(new Event('colloq:ready')))
  })
  /*
   * И только теперь — оболочку снимают.
   *
   * Смонтированный App — это ещё не экран: под оболочкой в этот миг стоит
   * `{#await}` над куском маршрута и пустые `session`/`adminAuth`. Уходя
   * здесь, заставка открывала скелет — серую вёрстку экрана, о котором ещё
   * ничего не известно. Ждём, пока первому экрану будет что показать
   * (lib/boot.ts), и не дольше потолка: дальше на месте данных встаёт та же
   * заставка приложения, в тех же координатах.
   */
  await whenFirstScreen()
  /*
   * Кадр на отрисовку доложенного: `firstScreenReady` зовут из эффекта, то
   * есть после правки DOM, но до того, как её покажут. Без этой паузы между
   * уходящей оболочкой и готовым экраном успевал мелькнуть пустой грунт.
   *
   * С запасным будильником: фоновая вкладка кадров не выдаёт вовсе, и ждать
   * там нечего — оболочку всё равно никто не видит, а висеть до возвращения
   * на вкладку она не должна.
   */
  await new Promise<void>((paint) => {
    requestAnimationFrame(() => paint())
    setTimeout(paint, 100)
  })
  dismissShell()
})().catch(offerReload)
