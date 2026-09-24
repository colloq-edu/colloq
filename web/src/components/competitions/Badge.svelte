<script lang="ts">
  /**
   * The state badge — one for all competition screens.
   *
   * `@shared/competitions` (`entrantBadge`) names the tone and the form; only
   * the paint is here. They are split the same way as in the mockup: a pale
   * fill is an outcome, a saturated fill is what is happening right now
   * ("RUNNING") or what only the teacher sees ("METRIC FAILED"), an outline
   * is waiting.
   *
   * The backgrounds of errors and results come from the colour tokens. In
   * the light theme the fill is weaker: a saturated background lowers the
   * contrast of coloured text.
   */
  import type { BadgeForm, BadgeTone } from '@shared/competitions'

  interface Props {
    word: string
    tone: BadgeTone
    form: BadgeForm
    /** On a phone the padding is tighter; the text size stays the same. */
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
  // The outline badge gets a pixel less padding than the filled one: the
  // border eats its own row of pixels, and without this "IN QUEUE" stands two
  // pixels taller than the neighbouring "DONE".
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
