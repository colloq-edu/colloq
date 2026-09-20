<script lang="ts">
  /**
   * Плашка состояния — одна на все экраны соревнований.
   *
   * Тон и форму называет `@shared/competitions` (`entrantBadge`), здесь только
   * краски. Разведены они так же, как в макете: залитая бледным — исход,
   * залитая насыщенным — то, что происходит прямо сейчас («ВЫПОЛНЯЕТСЯ») или
   * то, что видит только преподаватель («УПАЛА МЕТРИКА»), контурная — ожидание.
   *
   * Подложки заданы литералами, потому что в документе они и есть литералы:
   * шесть бледных тонов, которых нет среди токенов. Ночная тема их не знает
   * вовсе (ни один артборд соревнований не нарисован ночью), поэтому там тот
   * же цвет берётся прозрачностью от своего токена — иначе бледно-розовая
   * плашка светилась бы на тёмном грунте, как лампа.
   */
  import type { BadgeForm, BadgeTone } from '@shared/competitions'

  interface Props {
    word: string
    tone: BadgeTone
    form: BadgeForm
    /** Телефон: 10 px вместо 11 и отбивка уже (P4). */
    phone?: boolean
  }

  const { word, tone, form, phone = false }: Props = $props()

  const PAINT: Record<BadgeTone, Record<BadgeForm, string>> = {
    accent: {
      strong: 'bg-accent text-white dark:text-accent-ink',
      filled: 'bg-[#DDF3FB] text-accent-text dark:bg-accent/20 dark:text-accent',
      outline: 'border border-accent-text text-accent-text dark:border-accent dark:text-accent',
    },
    positive: {
      strong: 'bg-positive text-white',
      filled: 'bg-[#DCF2EC] text-positive dark:bg-positive/20',
      outline: 'border border-positive text-positive',
    },
    danger: {
      strong: 'bg-danger text-white',
      filled: 'bg-[#FBE3E6] text-danger dark:bg-danger/20',
      outline: 'border border-danger text-danger',
    },
    warning: {
      strong: 'bg-warning text-white',
      filled: 'bg-[#FBF0DC] text-warning dark:bg-warning/20',
      outline: 'border border-warning text-warning',
    },
    neutral: {
      strong: 'bg-brand text-white',
      filled: 'bg-raised text-brand dark:text-ink',
      outline: 'border border-line text-muted',
    },
  }

  const paint = $derived(PAINT[tone][form])
  // Контурная плашка на пиксель ниже залитой: рамка съедает свою строку, и без
  // этого «В ОЧЕРЕДИ» стоит на два пикселя выше соседнего «ГОТОВО».
  const pad = $derived(
    phone
      ? form === 'outline' ? 'px-1.5 py-px' : 'px-1.5 py-0.5'
      : form === 'outline' ? 'px-2 py-[2px]' : 'px-2 py-[3px]',
  )
</script>

<span
  class="inline-block shrink-0 whitespace-nowrap font-black uppercase {phone
    ? 'text-[10px] leading-3'
    : 'text-[11px] leading-[14px]'} tracking-label {paint} {pad}"
>
  {word}
</span>
