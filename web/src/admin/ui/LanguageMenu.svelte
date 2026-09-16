<script lang="ts">
  import { onMount } from 'svelte'
  import { tr } from '@shared/i18n'
  import type { Locale } from '@shared/i18n-types'
  import { language, revalidateLanguage } from '@/lib/i18n.svelte'
  import { adminApi } from '@/lib/adminApi'
  import { languageMenuPosition } from '@/admin/language-menu'
  import Icon from '@/components/ui/Icon.svelte'

  const options: { value: Locale; label: string }[] = [
    { value: 'ru', label: 'Русский' },
    { value: 'en', label: 'English' },
  ]
  const currentName = $derived(language.current === 'ru' ? 'Русский' : 'English')
  let trigger: HTMLButtonElement
  let menu: HTMLDivElement
  let opened = $state(false)
  let saving = $state(false)
  let failed = $state(false)
  let requested = $state<Locale | null>(null)

  function position(): void {
    if (!menu?.matches(':popover-open')) return
    const point = languageMenuPosition(trigger.getBoundingClientRect(), { width: menu.offsetWidth, height: menu.offsetHeight }, {
      width: window.innerWidth, height: window.innerHeight,
    })
    menu.style.left = `${point.left}px`
    menu.style.top = `${point.top}px`
  }

  function close(restoreFocus = false): void {
    menu.hidePopover()
    opened = false
    if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true })
  }

  function show(edge?: 'first' | 'last'): void {
    menu.showPopover()
    opened = true
    position()
    const items = menu.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')
    const focus = edge === 'first' ? items[0] : edge === 'last' ? items[items.length - 1]
      : menu.querySelector<HTMLButtonElement>(`[data-language="${language.current}"]`)
    focus?.focus({ preventScroll: true })
  }

  function menuKeys(event: KeyboardEvent): void {
    if (event.key === 'Tab') {
      // Let native focus navigation finish before hiding its starting element.
      setTimeout(() => { if (menu.isConnected && opened) close() }, 0)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = [...menu.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next]?.focus({ preventScroll: true })
  }

  function focusLeft(event: FocusEvent): void {
    // During focusout activeElement can still be body, even for an internal
    // pointer move. relatedTarget identifies the actual destination reliably.
    const next = event.relatedTarget
    if (next instanceof Node && (menu.contains(next) || next === trigger)) return
    if (opened) close()
  }

  async function choose(value: Locale): Promise<void> {
    if (saving) return
    if (value === language.current && !failed) { close(true); return }
    requested = value
    // Retry disappears when the error clears. Move its focus onto a stable row
    // first so removing it cannot dismiss the pending menu.
    if (menu.contains(document.activeElement)) {
      menu.querySelector<HTMLButtonElement>(`[data-language="${value}"]`)?.focus({ preventScroll: true })
    }
    saving = true
    failed = false
    try {
      await adminApi.updateInstanceSettings({ language: value })
      // A delayed PATCH response may describe an older choice. Confirm current server state.
      await revalidateLanguage()
      if (menu.isConnected && menu.matches(':popover-open')) close(menu.contains(document.activeElement))
    } catch {
      failed = true
    } finally {
      saving = false
    }
  }

  onMount(() => {
    const observer = new ResizeObserver(position)
    observer.observe(trigger)
    observer.observe(menu)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  })
</script>

<div class="mt-auto shrink-0 border-t border-white/15">
  <button
    bind:this={trigger}
    id="instance-language"
    type="button"
    aria-haspopup="menu"
    aria-expanded={opened}
    aria-controls="instance-language-menu"
    aria-label={tr('admin.language.current', { language: currentName })}
    title={failed ? tr('admin.language.failed') : tr('admin.language.current', { language: currentName })}
    class="flex h-12 w-full items-center justify-center gap-1 text-white transition-colors duration-100 hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent md:justify-start md:gap-[11px] md:px-5 {opened ? 'bg-white/[0.08]' : ''}"
    onclick={() => opened ? close() : show()}
    onkeydown={(event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        show(event.key === 'ArrowDown' ? 'first' : 'last')
      }
    }}
  >
    <Icon name={failed ? 'alert' : 'globe'} size={16} class="shrink-0 text-white/80" />
    <span class="hidden flex-1 text-left text-[14px] leading-5 md:block" lang={language.current}>{currentName}</span>
    <span class="font-mono text-micro leading-4 md:hidden">{language.current.toUpperCase()}</span>
    <span class="hidden w-3 shrink-0 items-center justify-center text-white/80 md:flex">
      <Icon name={saving ? 'spinner' : 'chevron-up'} size={12} class={saving ? 'animate-spin motion-reduce:animate-none' : ''} />
    </span>
  </button>
  <span role="status" class="sr-only">{saving ? tr('admin.language.saving') : !opened && failed ? tr('admin.language.failed') : ''}</span>
</div>

<div
  bind:this={menu}
  id="instance-language-menu"
  popover="auto"
  role="menu"
  tabindex="-1"
  aria-labelledby="language-menu-title"
  aria-describedby="language-menu-scope"
  aria-busy={saving}
  class="language-menu row-menu fixed m-0 w-[252px] max-w-[calc(100vw-16px)] max-h-[calc(100dvh-16px)] overflow-y-auto border border-line bg-canvas p-1.5 text-ink"
  style="transform-origin:bottom left;box-shadow:0 8px 24px -8px rgb(15 45 105 / 0.24)"
  ontoggle={(event) => { opened = (event as ToggleEvent).newState === 'open' }}
  onkeydown={menuKeys}
  onfocusout={focusLeft}
>
  <div id="language-menu-title" class="px-2.5 pb-3 pt-2.5 text-[14px] font-semibold leading-5">{tr('admin.language.label')}</div>
  {#each options as option (option.value)}
    <button
      type="button"
      role="menuitemradio"
      aria-checked={language.current === option.value}
      aria-disabled={saving}
      tabindex="-1"
      data-language={option.value}
      class="flex h-11 w-full items-center gap-3 px-2.5 text-left text-[14px] leading-5 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent aria-disabled:cursor-progress"
      class:bg-raised={language.current === option.value}
      class:font-semibold={language.current === option.value}
      onclick={() => void choose(option.value)}
    >
      <span class="flex-1" lang={option.value}>{option.label}</span>
      <span class="w-6 shrink-0 font-mono text-micro font-normal leading-4 text-muted">{option.value.toUpperCase()}</span>
      <span class="flex h-4 w-4 shrink-0 items-center justify-center text-brand">
        {#if saving && requested === option.value}
          <Icon name="spinner" size={16} class="animate-spin motion-reduce:animate-none" />
        {:else if language.current === option.value}
          <Icon name="check" size={16} />
        {/if}
      </span>
    </button>
  {/each}
  <div class="mt-1.5 border-t border-line px-2.5 pb-2 pt-2.5 text-2xs text-muted">
    <p id="language-menu-scope">{tr('admin.language.scope')}</p>
    {#if failed}
      <p role="alert" class="mt-2 text-danger">{tr('admin.language.failed')}</p>
      <button type="button" role="menuitem" tabindex="-1" class="mt-2 min-h-8 font-semibold text-ink underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" onclick={() => requested && void choose(requested)}>{tr('admin.language.retry')}</button>
    {/if}
  </div>
</div>
