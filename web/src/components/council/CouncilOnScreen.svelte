<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Плашка показанной попытки — то, что видит под ячейкой вся комната.
   *
   * «Показать классу» раньше переписывало общий текст ячейки чужим решением от
   * имени преподавателя: заготовка исчезала у всех, автором правки в истории
   * значился ведущий, а на экране ничто не говорило, что это чьё-то решение —
   * ни имени, ни чипа, ни строки в событиях. Теперь показ — это приставка к той
   * же ячейке: подпись, код и преподавательский вывод под одной полосой цвета
   * positive, а сама ячейка остаётся ячейкой.
   *
   * Одна разметка на два места: у студента она стоит под его собственным
   * листом, у преподавателя — под стопкой. Разница ровно в одной ссылке справа
   * («убрать с экрана»), и она есть только у того, кто вправе её нажать.
   *
   * Автор показанного этой плашки не видит НИКОГДА: его код и так перед ним, а
   * второй такой же блок под ним — это два одинаковых кода подряд. Ему вместо
   * чипа консилиума горит зелёное «Ваш вариант на экране» (CellView · подвал
   * листа); решает это вызывающая сторона, здесь об авторстве не знают.
   */
  import type { CouncilShown } from '@shared/protocol'
  import { clock } from '@/lib/history'
  import { cn, spell } from '@/lib/utils'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Code from '@/components/ui/Code.svelte'
  import CellOutputs from '@/components/notebook/CellOutputs.svelte'

  interface Props {
    shown: CouncilShown
    /** Ведущий: только у него справа «убрать с экрана». */
    mayClear?: boolean
    onclear?: () => void
  }

  let { shown, mayClear = false, onclear }: Props = $props()

  const CAPS = 'text-2xs font-bold uppercase tracking-label'

  /**
   * Подпись под именем: кто вывел, когда и сколько ещё написали то же самое.
   *
   * Время — только настоящее: у показа, начатого до того, как его стали
   * подписывать (комната шла на прежней версии), его нет, и выдуманный час был
   * бы хуже молчания. «Так же написали ещё K» появляется, когда K есть: ноль в
   * этой строке — шум рядом с числом, ради которого её и читают.
   */
  const line = $derived.by(() => {
    const parts = [tr('room.ui.1256')]
    if (shown.shownAt !== null) parts.push(clock(shown.shownAt))
    if (shown.alsoWrote > 0) parts.push(tr('room.ui.1257', { count: shown.alsoWrote }))
    return parts.join(' · ')
  })
</script>

<!--
  Полоса одна на всё — плашка, код и вывод: это один объект, а не три соседних
  блока. Цвет positive — единственное место в тетради, где кромка меняет цвет
  посередине ячейки, и оправдание у него одно: ниже по колонке другой автор, и
  живёт этот кусок ровно столько, сколько его показывают.
-->
<div class="border-l-4 border-positive" data-council-shown>
  <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 bg-positive/10 px-3.5 py-2">
    <span class={cn(CAPS, 'shrink-0 bg-positive px-1.5 py-px text-canvas')}>{tr('room.ui.52')}</span>
    {#if shown.name !== null}
      <Avatar name={shown.name} color={shown.color ?? '#888888'} avatar={shown.avatar} size="xs" />
      <span class="min-w-0 truncate text-ui-lg font-bold text-ink">{shown.name}</span>
    {:else}
      <!--
        Имена на проекторе выключены: подписывает номер варианта, и кружок на
        месте аватара остаётся пустым — не чужое лицо и не дырка в строке.
        Номер присвоен на показе и не переезжает (protocol · CouncilShown).
      -->
      <span class="h-5 w-5 shrink-0 rounded-full bg-raised" aria-hidden="true"></span>
      <span class="text-ui-lg font-bold text-ink">{tr('room.ui.1255', { p0: shown.variant })}</span>
    {/if}
    <span class="text-2xs text-muted">{line}</span>
    {#if mayClear}
      <button
        type="button"
        class="ml-auto shrink-0 text-2xs text-accent-text hover:underline"
        onclick={() => onclear?.()}
      >{tr('room.ui.1254')}</button>
    {/if}
  </div>

  <div class="bg-surface px-4 py-1">
    <Code code={shown.text} />
  </div>

  <!--
    Вывод — преподавательский, и подписан как преподавательский.

    Свой запуск автора сюда не едет: под кодом на экране класс читает то, за
    что отвечает ведущий, — он же по этому выводу и говорит «верно». Волосяная
    линия между кодом и выводом — та же пара, что у обычной ячейки.
  -->
  {#if shown.run}
    <div
      class={cn('border-t', shown.run.state === 'error' ? 'bg-danger/5' : 'bg-canvas')}
      style:border-top-color="rgb(var(--line))"
    >
      {#if shown.run.outputs.length > 0}
        <div class="px-2 py-1.5">
          <CellOutputs outputs={shown.run.outputs} />
        </div>
      {/if}
      <p class={cn(CAPS, 'px-4 pb-1.5 pt-1 text-faint')}>
        {tr('room.ui.61')}{shown.run.ranMs === null ? '' : ` · ${spell(shown.run.ranMs)}`}
      </p>
    </div>
  {/if}
</div>
