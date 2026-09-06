<script lang="ts">
  /**
   * Поле ответа преподавателя — одному автору или всей группе.
   *
   * Черновик группе приезжает от оракула (CouncilOracle.drafts), но отправляет
   * его преподаватель под своим именем, поэтому текст здесь ПРАВИТСЯ, а не
   * подтверждается: кнопки «отправить как есть» нет намеренно, палец должен
   * пройти через поле. Компонент чистый: что ввели — отдаёт наверх, куда
   * отправлять — знает родитель.
   */
  import Icon from '@/components/ui/Icon.svelte'

  interface Props {
    /** Кому — уже словами: «Анне» или «всем 312». */
    to: string
    /** С чего начать; черновик оракула или пусто. */
    initial?: string
    /** Начальный текст — от оракула: строка под полем говорит, что его можно и нужно поправить. */
    fromOracle?: boolean
    onsend: (text: string) => void
    oncancel: () => void
  }

  let { to, initial = '', fromOracle = false, onsend, oncancel }: Props = $props()

  // Свой текст, а не привязка к `initial`: пересылка сводки не должна
  // затирать то, что преподаватель уже дописал.
  // svelte-ignore state_referenced_locally
  let text = $state(initial)

  function send(): void {
    const trimmed = text.trim()
    if (!trimmed) return
    onsend(trimmed)
  }

  function onkeydown(event: KeyboardEvent): void {
    // ⌘/Ctrl+Enter — отправить, Esc — закрыть; голый Enter — перенос строки,
    // потому что ответ группе редко влезает в одну.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      send()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      oncancel()
    }
  }
</script>

<div class="flex flex-col gap-2 border-l-4 border-accent bg-surface px-3 py-2.5">
  <p class="text-2xs font-bold uppercase tracking-label text-accent-text">Ответ · {to}</p>
  <!-- svelte-ignore a11y_autofocus -->
  <textarea
    class="field min-h-[72px] w-full resize-y text-ui"
    bind:value={text}
    placeholder="Что сказать…"
    rows="3"
    autofocus
    {onkeydown}
  ></textarea>
  <div class="flex flex-wrap items-center gap-2.5">
    <button type="button" class="btn-primary h-8" disabled={!text.trim()} onclick={send}>
      <Icon name="send" size={13} />
      Отправить {to}
    </button>
    <button type="button" class="btn-ghost h-8" onclick={oncancel}>Отмена</button>
    <span class="text-2xs text-muted">
      {#if fromOracle}
        черновик оракула — подпись будет вашей, поправьте перед отправкой
      {:else}
        увидят только адресаты · ⌘↵ отправить
      {/if}
    </span>
  </div>
</div>
