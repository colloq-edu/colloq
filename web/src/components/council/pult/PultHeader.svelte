<script lang="ts">
  import { tr } from '@shared/i18n'
  interface Props { cellIndex: number | null; title: string; onexit: () => void }
  let { cellIndex, title, onexit }: Props = $props()
  const where = $derived([cellIndex === null ? '' : tr('room.ui.1272', { p0: String(cellIndex).padStart(2, '0') }), title].filter(Boolean).join(' · '))
</script>
<header class="pult-header">
  <div class="pult-heading">
    <h1>{tr('room.pult.v2.title')}</h1>
    <p class="pult-context" title={where}>{where}</p>
  </div>
  <div class="pult-header-actions">
    <span class="pult-meta pult-private">{tr('room.pult.v2.private')}</span>
    <button type="button" class="pult-button" onclick={onexit}>{tr('room.ui.1271')} <span aria-hidden="true">↗</span></button>
  </div>
</header>
<style>
  .pult-header { display:flex; align-items:center; justify-content:space-between; gap:24px; flex-shrink:0; padding:20px var(--pult-pad); border-bottom:1px solid rgb(var(--line)); }
  .pult-heading { min-width:0; }
  h1 { font-size:26px; line-height:32px; font-weight:700; margin:0 0 6px; }
  .pult-context { margin:0; color:rgb(var(--muted)); font-size:14px; line-height:20px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pult-header-actions { display:flex; align-items:center; gap:20px; flex-shrink:0; }
  @media(max-width:1000px) { .pult-private { display:none; } }
  @media(max-width:650px) { .pult-header { padding-top:14px; padding-bottom:14px; gap:12px; } h1 { font-size:22px; line-height:28px; } }
</style>
