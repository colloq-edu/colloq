<script lang="ts">
  /**
   * Верхняя полоса страниц `/k` — 56 px, и ничего в ней, кроме «где я» и «кто я».
   *
   * Это не шапка комнаты и не панель преподавателя: ни ядра, ни присутствия, ни
   * настроек здесь нет вовсе, а человек приходит сюда со ссылки в чате курса и
   * должен за секунду понять, тот ли это сайт и он ли это.
   *
   * Марка — продуктовая (`Icon name="logo"`, девять клеток), а не та, что
   * нарисована в макете четырьмя квадратами: логотип у Colloq один на все
   * экраны, и вторая его версия на публичной странице читалась бы как чужой
   * сайт.
   */
  import { tr } from '@shared/i18n'
  import Icon from '@/components/ui/Icon.svelte'
  import { avatarLetter, avatarTint } from '@/lib/competition-words'
  import { COMPETITIONS_LANDING } from '@/lib/routes'

  interface Props {
    name: string | null
    onnavigate: (path: string) => void
    onkey: () => void
  }

  const { name, onnavigate, onkey }: Props = $props()
</script>

<header
  class="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-canvas px-4 sm:px-10"
>
  <a
    class="flex min-w-0 items-center gap-3.5 no-underline"
    href={COMPETITIONS_LANDING}
    onclick={(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey) return
      event.preventDefault()
      onnavigate(COMPETITIONS_LANDING)
    }}
  >
    <Icon name="logo" size={16} class="shrink-0 text-brand" />
    <span class="shrink-0 text-2xs font-black uppercase tracking-section text-brand">Colloq</span>
    <span class="hidden h-[18px] w-px shrink-0 bg-line sm:block" aria-hidden="true"></span>
    <span class="hidden truncate text-2xs text-muted sm:block">{tr('competitions.title')}</span>
  </a>

  {#if name}
    <div class="flex min-w-0 items-center gap-2.5">
      <span
        class="flex size-[26px] shrink-0 items-center justify-center rounded-full text-micro font-bold text-[#7A4A12]"
        style="background: {avatarTint(name)}"
        aria-hidden="true"
      >
        {avatarLetter(name)}
      </span>
      <span class="hidden truncate text-2xs font-bold text-ink sm:block">{name}</span>
      <button
        class="shrink-0 border-b border-dashed border-accent-text text-2xs text-accent-text"
        type="button"
        onclick={onkey}
      >
        {tr('competitions.p.keyLink')}
      </button>
    </div>
  {/if}
</header>
