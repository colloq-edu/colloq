<!--
  Строка вкладок центра: тетрадь или документ.

  Появляется только когда в комнате есть документ — в обычном семинаре её нет
  вовсе, и она не стоит ни пикселя высоты. Это и есть ответ на «чтобы не отняла
  место»: платит за неё только та комната, где смотрят лекцию.

  Здесь же — и режим, и где преподаватель. Отдельная плашка внизу читалки
  говорила то же самое вторым голосом; одно место надёжнее двух.
-->
<script lang="ts">
  import Icon from '@/components/ui/Icon.svelte'
  import type { Lead } from '@/lib/follow'

  interface Props {
    file: string
    mode: 'notebook' | 'document'
    /** За кем идём, если есть за кем. */
    lead: Lead | null
    page: number
    pages: number
    onmode: (mode: 'notebook' | 'document') => void
    /** Догнать преподавателя: читалка слушает это как счётчик. */
    oncatchup: () => void
  }

  let { file, mode, lead, page, pages, onmode, oncatchup }: Props = $props()

  /*
   * Отстал ли смотрящий. Порог, а не точное равенство: иначе строка мигает всё
   * занятие от дрожания прокрутки на пиксель.
   */
  const behind = $derived(lead !== null && lead.page !== page)

  const TAB =
    'flex items-center gap-2 px-4 text-ui transition-colors duration-100 ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40'
  const ON = 'bg-canvas font-semibold text-ink shadow-[inset_0_-2px_0_currentColor]'
  const OFF = 'text-muted hover:text-ink'
</script>

<div class="flex h-[38px] shrink-0 items-stretch border-b border-line bg-surface pl-5">
  <button type="button" class={`${TAB} ${mode === 'notebook' ? ON : OFF}`} onclick={() => onmode('notebook')}>
    <Icon name="board" size={14} />
    Тетрадь
  </button>
  <button
    type="button"
    class={`${TAB} ${mode === 'document' ? ON : OFF} min-w-0`}
    onclick={() => onmode('document')}
  >
    <Icon name="file" size={14} class="shrink-0" />
    <span class="truncate">{file}</span>
    {#if mode === 'notebook' && lead}
      <!-- Где преподаватель — видно и из тетради: иначе о том, что лекция
           уехала на другую страницу, узнаёшь, только переключившись. -->
      <span class="flex shrink-0 items-center gap-1.5 bg-raised px-1.5 py-0.5">
        <span class="h-1.5 w-1.5 rounded-full" style={`background:${lead.color}`}></span>
        <span class="text-2xs font-semibold text-muted">{lead.name} на стр. {lead.page}</span>
      </span>
    {/if}
  </button>

  <span class="flex-1"></span>

  {#if mode === 'document'}
    <div class="flex shrink-0 items-center gap-2.5 px-5">
      {#if behind && lead}
        <button
          type="button"
          class="flex items-center gap-1.5 border border-accent bg-canvas px-2 py-0.5
                 text-2xs font-semibold text-accent-text transition-colors duration-100 hover:bg-accent/5"
          onclick={oncatchup}
        >
          <span class="h-1.5 w-1.5 rounded-full" style={`background:${lead.color}`}></span>
          {lead.name} на стр. {lead.page} — догнать
        </button>
      {:else if lead}
        <span class="flex items-center gap-1.5">
          <span class="h-1.5 w-1.5 rounded-full" style={`background:${lead.color}`}></span>
          <span class="text-2xs font-semibold text-muted">Идём за {lead.name}</span>
        </span>
      {:else}
        <!-- Ведущего нет: экран остаётся где стоял, и об этом сказано, а не
             оставлено на догадку. -->
        <span class="text-2xs text-muted">Преподаватель вышел — дальше сами</span>
      {/if}
      {#if pages > 0}
        <span class="h-3.5 w-px bg-line" aria-hidden="true"></span>
        <span class="font-mono text-2xs text-muted">{page} / {pages}</span>
      {/if}
    </div>
  {/if}
</div>
