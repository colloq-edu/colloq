<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * Нижняя строка: слева — что сейчас на экране класса, справа — клавиши.
   *
   * Ручки имён здесь больше нет: «подписывать ли на стене» — правило ЯЧЕЙКИ и
   * живёт в регламенте вместе с остальными тремя (PultRules.svelte). Строка
   * состояния осталась тем, чем была, — зеркалом зала: что он видит прямо
   * сейчас и сколько уже.
   *
   * И молчит, когда о том же говорит полоса «На экране класса» над списком:
   * два места, повторяющие одно имя в одном окне, — это не подстраховка, а
   * 32 px, отнятые у списка ради того, что уже написано выше.
   */
  interface Props {
    onScreen: string | null; inFrame: string; index: number; total: number;
    /** Полоса «На экране класса» сейчас видна — значит здесь про это молчим. */
    banner: boolean;
    onclear: () => void; onhelp: () => void
  }
  let { onScreen, inFrame, banner, onhelp }: Props = $props()
</script>
<footer class="pult-status">
  {#if !banner}
    <span class="pult-status-shown" class:shown={onScreen !== null} title={onScreen ?? undefined}>
      {onScreen === null ? tr('room.pult.v2.nothingShown') : tr('room.ui.1352', {p0:onScreen})}
      {#if onScreen !== null && inFrame}<span> · {inFrame}</span>{/if}
    </span>
  {:else}
    <span class="pult-status-shown"></span>
  {/if}
  <div class="pult-status-controls">
    <button type="button" class="pult-help" onclick={onhelp}><span aria-hidden="true">⌨</span> {tr('room.pult.v2.keys')}</button>
  </div>
</footer>
<style>
  .pult-status { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:32px; flex-shrink:0; padding:2px var(--pult-pad); border-top:1px solid rgb(var(--line)); background:rgb(var(--canvas)); color:rgb(var(--muted)); font-size:13px; }
  .pult-status-shown { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pult-status-shown.shown { color:rgb(var(--positive)); }
  .pult-status-controls { display:flex; align-items:center; gap:20px; flex-shrink:0; }
  .pult-help { display:flex; align-items:center; gap:8px; min-height:28px; font-size:13px; cursor:pointer; }
  /* На телефоне клавиш нет, а место под подсказку о них — есть у списка. */
  @media(max-width:650px) { .pult-status { display:none; } }
</style>
