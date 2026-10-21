<script lang="ts">
  /**
   * The sign-in key and signing in with a saved key — the right column of P1.
   *
   * An instance layer, not a competition one: there is one key per person,
   * and it stands to the SIDE of the list, not inside the cards. That is
   * exactly why it is shown large and every time, not once after joining: a
   * person who loses it loses their submissions and their place, and the
   * only one who can give them back is the teacher.
   *
   * `keyOnly` is the card alone, without the sign-in under it: the one a
   * competition's «Посылки» tab shows right after joining, above the send
   * box, so the key is in front of the person at the moment it is born
   * (CompetitionsScreen · joinedHere).
   */
  import { tr } from '@shared/i18n'
  import { copyText } from '@/lib/clipboard'
  import type { EntrantMe } from '@shared/competitions-entrant'
  import KeySignIn from './KeySignIn.svelte'

  interface Props {
    me: EntrantMe | null
    busy?: boolean
    /** A sign-in refusal, in the server's words: "no such key", "key turned off". */
    refusal?: string | null
    onsignin?: (key: string) => void
    onsignout?: () => void
    keyOnly?: boolean
  }

  const { me, busy = false, refusal = null, onsignin, onsignout, keyOnly = false }: Props = $props()

  let copied = $state<'key' | 'link' | null>(null)
  let copyFailed = $state(false)

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

<div class="flex w-full flex-col gap-5 {keyOnly ? 'max-w-[560px]' : ''}">
  {#if me?.entrant && me.key}
    <section class="flex flex-col border border-brand" data-key-card>
      <header class="bg-brand px-3.5 py-2.5">
        <h2 class="text-micro font-black uppercase leading-5 tracking-label text-white">
          {tr('competitions.p.keyTitle')}
        </h2>
      </header>
      <div class="flex flex-col gap-3 px-3.5 py-4">
        <!-- 22px of letter-spaced monospace: this number is copied by eye into
             a phone, and groups run together are the main way to get it
             wrong. -->
        <p class="select-all font-mono text-[22px] font-bold leading-7 tracking-[0.06em] text-ink">
          {me.key}
        </p>
        <p class="text-2xs leading-[19px] text-ink">{tr('competitions.p.keyExplain')}</p>
        <div class="flex gap-2">
          <button
            class="h-[34px] grow border border-primary text-micro font-bold text-primary hover:bg-surface"
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
        {#if onsignout}
          <button
            class="self-start border-b border-dashed border-accent-text text-micro text-accent-text"
            type="button"
            onclick={onsignout}
          >
            {tr('competitions.p.signOut')}
          </button>
        {/if}
      </div>
    </section>
  {:else if !keyOnly}
    <p class="text-2xs leading-[19px] text-muted">{tr('competitions.p.noKey')}</p>
  {/if}

  {#if !keyOnly && onsignin}
    <KeySignIn {busy} {refusal} {onsignin} />
  {/if}
</div>
