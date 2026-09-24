<script lang="ts" module>
  /**
   * The state badge — for competitions and submissions.
   *
   * One component for three screens, because the tone here carries meaning,
   * not mood: "METRIC FAILED" is the only saturated red in the product, and
   * it is red because the person looking at it is the one at fault. Spread
   * across three places, these rules would drift apart on the very first
   * edit.
   *
   * No words get in here: `shared/competitions.ts` names them
   * (`teacherBadge`, `competitionWord`) — one copy for the server and both
   * interfaces.
   */
  export type BadgeTone = 'accent' | 'positive' | 'danger' | 'warning' | 'neutral' | 'brand'
  export type BadgeForm = 'filled' | 'strong' | 'outline'

  /*
   * The saturated accent carries text that is NOT white, although it is
   * white in the mockup.
   *
   * White on `#0FA0D7` is 2.99:1, that is, below any threshold; the product
   * has already measured this pair and set up `--accent-ink` for it
   * (index.css). The "RUNNING" badge stands on the screen of a student who
   * looks at it from a phone in a lecture hall with daylight in the window —
   * and this is the only place where the mockup yields to the measurement.
   */
  const TONES: Record<BadgeTone, Record<BadgeForm, string>> = {
    accent: {
      filled: 'bg-accent/15 text-accent-text',
      strong: 'bg-accent text-accent-ink',
      outline: 'border border-accent-text text-accent-text',
    },
    positive: {
      filled: 'bg-positive/5 text-positive dark:bg-positive/15',
      strong: 'bg-positive text-white dark:text-canvas',
      outline: 'border border-positive text-positive',
    },
    danger: {
      filled: 'bg-danger/5 text-danger dark:bg-danger/10',
      strong: 'bg-danger text-white dark:text-canvas',
      outline: 'border border-danger text-danger',
    },
    warning: {
      filled: 'bg-warning/5 text-warning dark:bg-warning/15',
      strong: 'bg-warning text-white dark:text-canvas',
      outline: 'border border-warning text-warning',
    },
    neutral: {
      filled: 'bg-raised text-primary',
      strong: 'bg-muted text-white dark:text-canvas',
      outline: 'border border-line text-muted',
    },
    brand: {
      filled: 'bg-brand text-white',
      strong: 'bg-brand text-white',
      outline: 'border border-primary text-primary',
    },
  }
</script>

<script lang="ts">
  import { cn } from '@/lib/utils'

  interface Props {
    word: string
    tone?: BadgeTone
    form?: BadgeForm
    /** `lower` — in lowercase: that is how the "counted" mark is drawn. */
    case?: 'caps' | 'lower'
    class?: string
  }

  let { word, tone = 'neutral', form = 'filled', case: letters = 'caps', class: extra = '' }: Props =
    $props()
</script>

<span
  class={cn(
    'inline-flex shrink-0 items-center whitespace-nowrap px-2 py-0.5',
    letters === 'caps'
      ? 'text-micro font-bold uppercase tracking-caps'
      : 'text-micro font-semibold',
    TONES[tone][form],
    extra,
  )}
>
  {word}
</span>
