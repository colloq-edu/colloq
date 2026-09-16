<script lang="ts">
  import { tr } from '@shared/i18n'
  interface Props {
    onScreen: string | null; inFrame: string; names: boolean; index: number; total: number;
    disabled: boolean; onnames: (names: boolean) => void; onclear: () => void; onhelp: () => void
  }
  let { onScreen, inFrame, names, disabled, onnames, onhelp }: Props = $props()
</script>
<footer class="pult-status">
  <span class="pult-status-shown" class:shown={onScreen !== null} title={onScreen ?? undefined}>
    {onScreen === null ? tr('room.pult.v2.nothingShown') : tr('room.ui.1352', {p0:onScreen})}
    {#if onScreen !== null && inFrame}<span> · {inFrame}</span>{/if}
  </span>
  <div class="pult-status-controls">
    <button type="button" class="pult-names" role="switch" aria-checked={names} aria-label={tr('room.pult.v2.names')} {disabled} onclick={() => onnames(!names)}>
      <span class="pult-switch-track" class:on={names} aria-hidden="true"><span></span></span>
      {tr('room.pult.v2.names')}
    </button>
    <button type="button" class="pult-help" onclick={onhelp}><span aria-hidden="true">⌨</span> {tr('room.pult.v2.keys')}</button>
  </div>
</footer>
<style>
  .pult-status { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:44px; flex-shrink:0; padding:6px var(--pult-pad); border-top:1px solid rgb(var(--line)); background:rgb(var(--canvas)); color:rgb(var(--muted)); font-size:13px; }
  .pult-status-shown { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pult-status-shown.shown { color:rgb(var(--positive)); }
  .pult-status-controls { display:flex; align-items:center; gap:20px; flex-shrink:0; }
  .pult-names,.pult-help { display:flex; align-items:center; gap:8px; min-height:32px; font-size:14px; cursor:pointer; }
  .pult-names { color:rgb(var(--ink)); }
  .pult-names:disabled { opacity:.5; cursor:default; }
  .pult-switch-track { display:flex; align-items:center; justify-content:flex-start; flex-shrink:0; width:28px; height:16px; padding:2px; background:rgb(var(--line)); }
  .pult-switch-track.on { justify-content:flex-end; background:rgb(var(--primary)); }
  .pult-switch-track span { width:12px; height:12px; background:rgb(var(--canvas)); }
  @media(max-width:700px) { .pult-status { flex-wrap:wrap; gap:0 12px; } .pult-status-shown { flex-basis:100%; padding-top:4px; } .pult-status-controls { flex-wrap:wrap; } }
</style>
