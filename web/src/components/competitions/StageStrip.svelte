<script lang="ts">
  /**
   * Полоса этапов под идущей посылкой: ПРИНЯТА · ОЧЕРЕДЬ · ЗАПУСК ТЕТРАДИ ·
   * ПРОВЕРКА CSV · ОЦЕНКА.
   *
   * Она отвечает на единственный вопрос человека, который смотрит на таймер:
   * «оно вообще движется или висит». Цвет пройденного — зелёный, текущего —
   * ссылочный синий, будущего — бледный; трёх цветов хватает, потому что
   * четвёртого состояния у этапа не бывает.
   *
   * Только на десктопе. На телефоне её место занимает одна фраза («Выполняется
   * ячейка 9 из 14»): пять подписей в 390 px складываются в два ряда и
   * перестают читаться как одна линия.
   */
  import type { SubmissionStage, SubmissionState } from '@shared/competitions'
  import { stageStrip } from '@/lib/competition-words'

  interface Props {
    state: SubmissionState
    stage: SubmissionStage
  }

  const { state, stage }: Props = $props()
  const cells = $derived(stageStrip(state, stage))
</script>

<div class="flex flex-wrap items-center gap-2">
  {#each cells as cell, index (cell.stage)}
    {#if index > 0}
      <span class="h-px w-5 shrink-0 bg-line" aria-hidden="true"></span>
    {/if}
    <span
      class="text-micro font-black uppercase leading-5 tracking-label {cell.position ===
      'done'
        ? 'text-positive'
        : cell.position === 'current'
          ? 'text-accent-text'
          : 'text-faint'}"
    >
      {cell.word}
    </span>
  {/each}
</div>
