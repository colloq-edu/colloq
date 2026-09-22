<script lang="ts">
  /**
   * Плашка состояния — одна на все экраны соревнований.
   *
   * Тон и форму называет `@shared/competitions` (`entrantBadge`), здесь только
   * краски. Разведены они так же, как в макете: залитая бледным — исход,
   * залитая насыщенным — то, что происходит прямо сейчас («ВЫПОЛНЯЕТСЯ») или
   * то, что видит только преподаватель («УПАЛА МЕТРИКА»), контурная — ожидание.
   *
   * Подложки ошибок и результатов берутся от цветовых токенов. В светлой
   * теме заливка слабее: насыщенный фон снижает контраст цветного текста.
   */
  import type { BadgeForm, BadgeTone } from '@shared/competitions'

  interface Props {
    word: string
    tone: BadgeTone
    form: BadgeForm
    /** На телефоне компактнее отступы, размер текста сохраняется. */
    phone?: boolean
  }

  const { word, tone, form, phone = false }: Props = $props()

  const PAINT: Record<BadgeTone, Record<BadgeForm, string>> = {
    accent: {
      strong: 'bg-accent text-accent-ink',
      filled: 'bg-[#DDF3FB] text-accent-text dark:bg-accent/20 dark:text-accent',
      outline: 'border border-accent-text text-accent-text dark:border-accent dark:text-accent',
    },
    positive: {
      strong: 'bg-positive text-white dark:text-canvas',
      filled: 'bg-positive/5 text-positive dark:bg-positive/20',
      outline: 'border border-positive text-positive',
    },
    danger: {
      strong: 'bg-danger text-white dark:text-canvas',
      filled: 'bg-danger/5 text-danger dark:bg-danger/10',
      outline: 'border border-danger text-danger',
    },
    warning: {
      strong: 'bg-warning text-white dark:text-canvas',
      filled: 'bg-warning/5 text-warning dark:bg-warning/20',
      outline: 'border border-warning text-warning',
    },
    neutral: {
      strong: 'bg-brand text-white',
      filled: 'bg-raised text-primary dark:text-ink',
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
  class="inline-block shrink-0 whitespace-nowrap text-micro font-bold uppercase tracking-caps {paint} {pad}"
>
  {word}
</span>
