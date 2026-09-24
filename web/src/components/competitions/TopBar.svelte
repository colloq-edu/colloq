<script lang="ts">
  /**
   * The top bar of the `/k` pages — 56 px, and nothing in it but "where am I"
   * and "who am I".
   *
   * This is not the room header and not the teacher panel: there is no
   * kernel, no presence and no settings here at all, and a person arrives
   * here from a link in the course chat and must understand within a second
   * whether this is the right site and whether it is them.
   *
   * The mark is the product's (`Icon name="logo"`, nine cells), not the one
   * drawn in the mockup as four squares: Colloq has one logo for all screens,
   * and a second version of it on a public page would read as someone else's
   * site.
   */
  import { tr } from '@shared/i18n'
  import Icon from '@/components/ui/Icon.svelte'
  import { avatarLetter, avatarTint } from '@/lib/competition-words'
  import { COMPETITIONS_LANDING } from '@/lib/routes'

  interface Props {
    name: string | null
    onnavigate: (path: string) => void
    onkey: () => void
  }

  const { name, onnavigate, onkey }: Props = $props()
</script>

<header
  class="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-canvas px-4 sm:px-10"
>
  <a
    class="flex min-w-0 items-center gap-3.5 no-underline"
    href={COMPETITIONS_LANDING}
    onclick={(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey) return
      event.preventDefault()
      onnavigate(COMPETITIONS_LANDING)
    }}
  >
    <Icon name="logo" size={16} class="shrink-0 text-primary" />
    <span class="shrink-0 text-2xs font-black uppercase tracking-section text-primary">Colloq</span>
    <span class="hidden h-[18px] w-px shrink-0 bg-line sm:block" aria-hidden="true"></span>
    <span class="hidden truncate text-2xs text-muted sm:block">{tr('competitions.title')}</span>
  </a>

  {#if name}
    <div class="flex min-w-0 items-center gap-2.5">
      <span
        class="flex size-[26px] shrink-0 items-center justify-center rounded-full text-micro font-bold text-[#7A4A12]"
        style="background: {avatarTint(name)}"
        aria-hidden="true"
      >
        {avatarLetter(name)}
      </span>
      <span class="hidden truncate text-2xs font-bold text-ink sm:block">{name}</span>
      <button
        class="shrink-0 border-b border-dashed border-accent-text text-2xs text-accent-text"
        type="button"
        onclick={onkey}
      >
        {tr('competitions.p.keyLink')}
      </button>
    </div>
  {/if}
</header>
