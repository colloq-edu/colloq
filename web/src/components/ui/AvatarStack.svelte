<script lang="ts">
  import Avatar from '@/components/ui/Avatar.svelte'

  interface Person {
    id: string
    name: string
    avatar?: string | null
    color: string
    /** Overrides the hover label — "Maria (you)" rather than "Maria". */
    title?: string
  }

  interface Props {
    people: Person[]
    /** Faces shown before the rest collapse into a "+N" chip. */
    max?: number
    /** Diameter in px, ring included. */
    size?: number
    /** Ground colour the ring is drawn in, so the stack reads on navy and on white. */
    ring?: string
    /** Which ground the chip has to sit on — the faces carry their own colour. */
    tone?: 'onDark' | 'onLight'
  }

  let {
    people,
    max = 4,
    size = 26,
    ring = 'rgb(var(--canvas))',
    tone = 'onLight',
  }: Props = $props()

  const shown = $derived(people.slice(0, max))
  const rest = $derived(people.length - shown.length)

  /*
   * The artboards slide each face a third of its diameter under the one before
   * it — far enough to read as a group, not so far that a face becomes a
   * crescent. Rounded, because a half pixel here shows up as a wobbling lane.
   */
  const step = $derived(Math.round((size * 2) / 3))
  const overlap = $derived(size - step)

  /*
   * Avatar owns initials, emoji and the colour chip; only its box is retuned
   * here, because `size` arrives as a number of pixels and no utility class can
   * say that. The nearest Avatar size still picks the right type size.
   */
  const face = $derived(size <= 22 ? 'xs' : size <= 30 ? 'sm' : size <= 40 ? 'md' : 'lg')

  /*
   * Кегль метки — доля диаметра, а не ступень. Ступеней четыре, диаметров у
   * стопки сколько угодно, и на 28px ступень `sm` давала те же 14px, что на
   * 24px: круг вырос, человек в нём остался прежним.
   *
   * 0.58, потому что Apple Color Emoji рисует краску примерно в 0.94 кегля, а
   * Avatar хочет 0.55 диаметра — это и есть 0.55/0.94. Замерено на живой
   * стопке, а не выведено из метрик: у цветных растровых эмодзи
   * actualBoundingBox врёт и отдаёт коробку выкладки.
   */
  const glyph = $derived(Math.round(size * 0.58))
</script>

<div class="flex shrink-0 items-center">
  {#each shown as person, i (person.id)}
    <!-- First person on top, z descending rightwards, so the stack reads as a
         queue rather than as whoever happened to be last in the DOM. -->
    <!--
      flex, а не block. Аватар внутри — inline-flex, то есть строчный бокс, и в
      блочном родителе он садится на базовую линию: под ним остаётся место под
      выносные элементы, и лицо съезжает вниз и вылезает за кольцо. На круге в
      24px это три с половиной пикселя — лица стояли ниже чипа «+N», и полоса
      читалась кривой. Флекс-контейнер базовой линии не строит, и `width/height:
      100%` ниже кладёт лицо ровно в отверстие кольца.
    -->
    <span
      class="cell relative flex shrink-0 rounded-full"
      style="width: {size}px; height: {size}px; border: 2px solid {ring}; z-index: {shown.length -
        i}; margin-left: {i === 0 ? 0 : -overlap}px"
    >
      <Avatar
        name={person.name}
        color={person.color}
        avatar={person.avatar}
        title={person.title}
        size={face}
        emojiPx={glyph}
      />
    </span>
  {/each}

  {#if rest > 0}
    <span
      class="relative flex shrink-0 items-center justify-center rounded-full text-micro font-bold leading-none {tone ===
      'onDark'
        ? 'bg-white/15 text-white'
        : 'bg-raised text-muted ring-1 ring-inset ring-line'}"
      style="width: {size}px; height: {size}px; border: 2px solid {ring}; z-index: 0; margin-left: {-overlap}px"
    >
      +{rest}
    </span>
  {/if}
</div>

<style>
  /* Avatar sizes itself off a fixed step of utility classes; the stack sizes in
     px, so the face fills whatever box the ring leaves it. */
  .cell > :global(span) {
    width: 100%;
    height: 100%;
  }
</style>
