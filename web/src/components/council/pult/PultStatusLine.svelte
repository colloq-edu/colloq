<script lang="ts">
  import { tr } from '@shared/i18n'
  /**
   * The bottom line: on the left, what is on the class screen now; on the
   * right, the keys.
   *
   * The names control is no longer here: "whether to caption it on the
   * wall" is a CELL rule and lives in the rules together with the other
   * three (PultRules.svelte). The status line stayed what it was — a mirror
   * of the room: what it sees right now and for how long already.
   *
   * And it stays silent when the "On the class screen" strip above the list
   * says the same thing: two places repeating one name in one window are not
   * a safety net but 32 px taken away from the list for what is already
   * written above.
   */
  interface Props {
    onScreen: string | null; inFrame: string; index: number; total: number;
    /** The "On the class screen" strip is up, so this line keeps quiet about it. */
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
  /* A phone has no keys, but the room for a hint about them belongs to the list. */
  @media(max-width:650px) { .pult-status { display:none; } }
</style>
