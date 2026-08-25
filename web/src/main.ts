import { mount } from 'svelte'
import './index.css'
import App from './App.svelte'

const target = document.getElementById('root')
if (!target) throw new Error('Colloq: #root is missing from index.html')

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
  const shell = document.getElementById('boot')
  if (!shell) return
  shell.dataset.leaving = ''
  const drop = () => shell.remove()
  shell.addEventListener('transitionend', drop, { once: true })
  // A backgrounded tab never fires transitionend, and this must not linger.
  setTimeout(drop, 400)
}

mount(App, { target })
void stylesApplied().then(dismissShell)
