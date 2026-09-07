<script lang="ts">
  /**
   * Одно меню бана на всю комнату — и окно, которым его подтверждают.
   *
   * Нажимают в двух местах: правой кнопкой по строке в списке людей и по автору
   * записи в треде оракула. Меню при этом одно, и живёт оно здесь, у самого
   * верха экрана, а не внутри той панели, из которой его позвали. Так пришлось
   * бы сделать и без разговоров про единообразие: обе панели прокручиваются и
   * обрезают всё, что вылезает за их край, — всплывающее меню внутри рельса
   * шириной 240 пикселей обрезалось бы ровно тогда, когда его открыли у нижней
   * строки.
   *
   * Подтверждение обязательно, и оно перечисляет ВСЁ, что случится. Бан —
   * единственное в продукте наказание, и у него есть последствие, о котором
   * никто не догадается сам: вопросы человека уходят из общей ленты. Поэтому
   * там же сказано, чем их вернуть, и там же — что метка держится на браузере.
   * Обещать герметичность, которой нет, дороже, чем признать её отсутствие.
   */
  import { quintOut } from 'svelte/easing'
  import { fade, fly } from 'svelte/transition'
  import { api } from '@/lib/api'
  import { BAN_MENU_EVENT, banConsequences, bansChanged, type BanTarget } from '@/lib/bans'
  import { getSessionState } from '@/lib/session.svelte'
  import { prefersReducedMotion } from '@/lib/utils'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon from '@/components/ui/Icon.svelte'

  const session = getSessionState()

  let target = $state<BanTarget | null>(null)
  /** Меню нажато — на экране окно подтверждения. */
  let asked = $state(false)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let cancelButton = $state<HTMLButtonElement | null>(null)

  $effect(() => {
    const open = (event: Event) => {
      target = (event as CustomEvent<BanTarget>).detail
      asked = false
      busy = false
      error = null
    }
    window.addEventListener(BAN_MENU_EVENT, open)
    return () => window.removeEventListener(BAN_MENU_EVENT, open)
  })

  // Отказаться — рефлекс, поэтому под первым же Enter стоит «Отмена».
  $effect(() => {
    if (asked) cancelButton?.focus()
  })

  const MENU_W = 208
  const MENU_H = 44
  /**
   * Меню не вылезает за окно.
   *
   * По правой кнопке по нижней строке списка — обычное дело, а меню, ушедшее
   * под нижнюю кромку, выглядит как не сработавшее нажатие.
   */
  const at = $derived.by(() => {
    if (!target) return { x: 0, y: 0 }
    return {
      x: Math.max(8, Math.min(target.x, window.innerWidth - MENU_W - 8)),
      y: Math.max(8, Math.min(target.y, window.innerHeight - MENU_H - 8)),
    }
  })

  /**
   * Закрыть — и только когда закрывать ещё есть что.
   *
   * Пока запрос в пути, «Отмена» погашена: отменить уже нечего, сервер бан
   * поставит. Escape и щелчок по подложке при этом окно уносили — человек
   * видел, что «передумал», а через мгновение участник оказывался удалён; а
   * отказ сервера ложился текстом в окно, которого на экране больше нет.
   * Тот же `busy` теперь держит и их: единственный выход из ожидания — его
   * конец.
   */
  function dismiss(): void {
    target = null
    asked = false
  }

  /** То же, но по жесту человека: пока запрос в пути, жест не действует. */
  function close(): void {
    if (busy) return
    dismiss()
  }

  async function ban(): Promise<void> {
    const who = target
    if (!who || busy) return
    busy = true
    error = null
    try {
      await api.ban(session.session.id, session.token, who.id)
      // Список у преподавателя перечитывается сам: он рисуется в другой панели,
      // и без этого свежий бан появился бы в нём только через минуту.
      bansChanged()
      // Не `close`: `busy` снимается только в finally, и жестовый выход из
      // него как раз и не сработал бы.
      dismiss()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Не получилось удалить с занятия.'
    } finally {
      busy = false
    }
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape' && target) close()
  }}
/>

{#if target && !asked}
  <!-- Подложка ловит нажатие мимо меню — тем же способом, что и пульт правил. -->
  <div class="fixed inset-0 z-40" role="presentation" onclick={close}></div>
  <!--
    Только вход, и кривая — домашняя. Здесь и у окна ниже.

    `transition:` двусторонняя, и уход по ней анимируется тоже: Escape (см.
    `svelte:window` выше) уводил меню за 120 мс, хотя клавишу жмут ровно затем,
    чтобы его УБРАТЬ. Анимировать действие с клавиатуры нельзя — то же решение
    принято для ящиков и пульта правил в SessionScreen и записано словами в
    admin/motion.css. `quintOut` = 1−(1−t)⁵ — ближайшая из svelte/easing к
    `--ease-out` (index.css), которой в этом продукте движется всё; `cubicOut`
    заметно мягче и читается как чужая.
  -->
  <div
    class="fixed z-50 border border-line bg-raised py-1 shadow-pop"
    style="left: {at.x}px; top: {at.y}px; width: {MENU_W}px"
    role="menu"
    aria-label="Что сделать с участником"
    in:fly={{ y: prefersReducedMotion() ? 0 : -4, duration: 120, easing: quintOut }}
  >
    <p class="truncate px-2.5 pb-1 pt-0.5 text-2xs font-bold uppercase tracking-label text-muted">
      {target.name}
    </p>
    <button
      role="menuitem"
      type="button"
      class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-ui text-danger
             transition-colors duration-100 hover:bg-danger/[0.08]
             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
      onclick={() => (asked = true)}
    >
      <Icon name="lock" size={14} />
      Удалить с занятия…
    </button>
  </div>
{/if}

{#if target && asked}
  {@const who = target}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
    role="presentation"
    onclick={(event) => {
      if (event.target === event.currentTarget) close()
    }}
    in:fade={{ duration: 120 }}
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="ban-title"
      class="w-full max-w-[440px] border border-line bg-canvas p-5 shadow-pop"
      in:fly={{ y: prefersReducedMotion() ? 0 : -6, duration: 140, easing: quintOut }}
    >
      <h2 id="ban-title" class="text-title font-semibold text-ink">Удалить с занятия</h2>

      <!-- Имя — отдельной строкой с меткой, а не внутри заголовка: в списке
           людей одни имена, лиц там нет, и промахнуться строкой легко. -->
      <div class="mt-3 flex items-center gap-2.5 border border-line bg-surface px-3 py-2.5">
        <Avatar name={who.name} color={who.color} avatar={who.avatar} size="sm" />
        <span class="min-w-0 flex-1 truncate text-ui-lg font-semibold text-ink">{who.name}</span>
      </div>

      <ul class="mt-3 flex flex-col gap-1.5">
        {#each banConsequences(who.name) as line (line)}
          <li class="flex gap-2 text-ui leading-relaxed text-muted">
            <span class="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-faint" aria-hidden="true"></span>
            <span class="min-w-0">{line}</span>
          </li>
        {/each}
      </ul>

      {#if error}
        <p class="mt-3 text-ui text-danger" role="alert">{error}</p>
      {/if}

      <div class="mt-5 flex justify-end gap-2">
        <button
          bind:this={cancelButton}
          type="button"
          class="btn-outline"
          disabled={busy}
          onclick={close}
        >
          Отмена
        </button>
        <button
          type="button"
          class="btn bg-danger text-white hover:brightness-110 active:brightness-95"
          disabled={busy}
          onclick={() => void ban()}
        >
          {#if busy}
            <Icon name="spinner" size={15} class="animate-spin" />
            Удаляем…
          {:else}
            <Icon name="lock" size={15} />
            Удалить с занятия
          {/if}
        </button>
      </div>
    </div>
  </div>
{/if}
