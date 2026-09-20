<script lang="ts">
  /**
   * Ключ входа и вход по сохранённому ключу — правая колонка P1.
   *
   * Слой инстанса, а не соревнования: ключ один на человека, и он стоит СБОКУ
   * от списка, а не внутри карточек. Ровно поэтому он показан крупно и каждый
   * раз, а не однажды после вступления: человек, потерявший его, теряет свои
   * посылки и своё место, и единственный, кто может вернуть их, — преподаватель.
   */
  import { tr } from '@shared/i18n'
  import { copyText } from '@/lib/clipboard'
  import { normalizeEntrantKey } from '@shared/competitions'
  import type { EntrantMe } from '@shared/competitions-entrant'

  interface Props {
    me: EntrantMe | null
    busy: boolean
    /** Отказ входа — словами сервера: «такого ключа нет», «ключ отключён». */
    refusal: string | null
    onsignin: (key: string) => void
    onsignout: () => void
  }

  const { me, busy, refusal, onsignin, onsignout }: Props = $props()

  let typed = $state('')
  let copied = $state<'key' | 'link' | null>(null)
  let copyFailed = $state(false)

  // Ключ диктуют вслух и переписывают с доски: строчные буквы, пробелы вместо
  // дефисов и лишние дефисы приводит к виду тот же разбор, что на сервере.
  const clean = $derived(normalizeEntrantKey(typed))
  const canSignIn = $derived(clean !== null)

  async function copy(what: 'key' | 'link', text: string): Promise<void> {
    copyFailed = false
    try {
      await copyText(text)
      copied = what
      setTimeout(() => {
        if (copied === what) copied = null
      }, 1500)
    } catch {
      copyFailed = true
    }
  }
</script>

<div class="flex w-full flex-col gap-5">
  {#if me?.entrant && me.key}
    <section class="flex flex-col border border-brand" data-key-card>
      <header class="bg-brand px-3.5 py-2.5">
        <h2 class="text-[11px] font-black uppercase leading-[14px] tracking-label text-white">
          {tr('competitions.p.keyTitle')}
        </h2>
      </header>
      <div class="flex flex-col gap-3 px-3.5 py-4">
        <!-- 22px моноширинного с разрядкой: это число переписывают глазами в
             телефон, и слипшиеся группы — главный способ ошибиться. -->
        <p class="select-all font-mono text-[22px] font-bold leading-7 tracking-[0.06em] text-ink">
          {me.key}
        </p>
        <p class="text-2xs leading-[19px] text-ink">{tr('competitions.p.keyExplain')}</p>
        <div class="flex gap-2">
          <button
            class="h-[34px] grow border border-brand text-micro font-bold text-brand hover:bg-surface"
            type="button"
            onclick={() => copy('key', me.key ?? '')}
          >
            {copied === 'key' ? tr('competitions.p.copied') : tr('competitions.p.keyCopy')}
          </button>
          <button
            class="h-[34px] grow border border-line text-micro text-ink hover:bg-surface"
            type="button"
            disabled={!me.link}
            onclick={() => copy('link', me.link ?? '')}
          >
            {copied === 'link' ? tr('competitions.p.copied') : tr('competitions.p.keyLinkButton')}
          </button>
        </div>
        {#if copyFailed}
          <p class="text-micro leading-[18px] text-danger">{tr('common.networkError')}</p>
        {/if}
        <p class="text-micro leading-[18px] text-muted">{tr('competitions.p.keyFootnote')}</p>
        <button
          class="self-start border-b border-dashed border-accent-text text-micro text-accent-text"
          type="button"
          onclick={onsignout}
        >
          {tr('competitions.p.signOut')}
        </button>
      </div>
    </section>
  {:else}
    <p class="text-2xs leading-[19px] text-muted">{tr('competitions.p.noKey')}</p>
  {/if}

  <form
    class="flex flex-col gap-2"
    onsubmit={(event) => {
      event.preventDefault()
      if (canSignIn && clean) onsignin(clean)
    }}
  >
    <h2 class="text-[11px] font-black uppercase leading-[14px] tracking-label text-muted">
      {tr('competitions.p.signInTitle')}
    </h2>
    <div class="flex gap-2">
      <input
        class="h-9 min-w-0 grow border border-line bg-canvas px-3 font-mono text-2xs uppercase text-ink placeholder:font-sans placeholder:normal-case placeholder:text-faint focus:border-accent focus:outline-none"
        placeholder={tr('competitions.p.keyPlaceholder')}
        bind:value={typed}
        autocomplete="off"
        spellcheck="false"
      />
      <button
        class="h-9 shrink-0 border border-line px-3.5 text-2xs text-ink hover:bg-surface disabled:text-faint"
        type="submit"
        disabled={!canSignIn || busy}
      >
        {tr('competitions.p.signIn')}
      </button>
    </div>
    {#if refusal}
      <p class="text-micro leading-[18px] text-danger">{refusal}</p>
    {:else if typed.trim() && !canSignIn}
      <p class="text-micro leading-[18px] text-muted">{tr('competitions.p.keyShape')}</p>
    {/if}
  </form>
</div>
