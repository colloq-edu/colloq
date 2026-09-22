<script lang="ts" module>
  /**
   * Плашка состояния — соревнования и посылки.
   *
   * Одним компонентом на три экрана, потому что тон здесь несёт смысл, а не
   * настроение: «УПАЛА МЕТРИКА» — единственная насыщенно-красная в продукте, и
   * красная она потому, что виноват в ней тот, кто на неё смотрит. Разложив
   * эти правила по трём местам, их развели бы на первой же правке.
   *
   * Слова сюда не попадают: их называет `shared/competitions.ts`
   * (`teacherBadge`, `competitionWord`) — одной копией на сервер и на оба
   * интерфейса.
   */
  export type BadgeTone = 'accent' | 'positive' | 'danger' | 'warning' | 'neutral' | 'brand'
  export type BadgeForm = 'filled' | 'strong' | 'outline'

  /*
   * Насыщенный accent несёт НЕ белый текст, хотя в макете он белый.
   *
   * Белое на `#0FA0D7` — это 2.99:1, то есть ниже любого порога; продукт эту
   * пару уже мерил и завёл под неё `--accent-ink` (index.css). Плашка
   * «ВЫПОЛНЯЕТСЯ» стоит на экране студента, который смотрит на неё с телефона
   * в аудитории со светом в окно, — и это единственное место, где макет
   * уступает измерению.
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
    /** `lower` — строчными: так нарисована пометка «в зачёт». */
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
