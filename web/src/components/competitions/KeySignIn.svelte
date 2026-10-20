<script lang="ts">
  /**
   * Signing in with a saved key: the form under the key card of P1, and the
   * second way in on a competition's join step (JoinStep).
   *
   * One form for both places, because it is one door with one parsing: a key
   * dictated out loud or copied from the board comes in lowercase, with spaces
   * for dashes, and `normalizeEntrantKey` reads it the way the server will.
   */
  import { tr } from '@shared/i18n'
  import { normalizeEntrantKey } from '@shared/competitions'

  interface Props {
    busy: boolean
    /** A sign-in refusal, in the server's words: "no such key", "key turned off". */
    refusal: string | null
    onsignin: (key: string) => void
    /** The heading's id, which names the field: unique on the page. */
    id?: string
    /** The key field, for a step that hands it the focus. */
    field?: HTMLInputElement | null
  }

  let { busy, refusal, onsignin, id = 'competition-signin-title', field = $bindable(null) }: Props = $props()

  let typed = $state('')
  const clean = $derived(normalizeEntrantKey(typed))
  const canSignIn = $derived(clean !== null)
</script>

<form
  class="flex flex-col gap-2"
  onsubmit={(event) => {
    event.preventDefault()
    if (canSignIn && clean) onsignin(clean)
  }}
>
  <h2 {id} class="text-ui font-bold text-ink">
    {tr('competitions.p.signInTitle')}
  </h2>
  <div class="flex gap-2">
    <input
      bind:this={field}
      class="h-11 min-w-0 w-full grow border border-line bg-canvas px-3 font-mono text-ui uppercase text-ink placeholder:font-sans placeholder:normal-case placeholder:text-muted focus:border-accent focus:outline-none"
      aria-labelledby={id}
      placeholder={tr('competitions.p.keyPlaceholder')}
      bind:value={typed}
      autocomplete="off"
      spellcheck="false"
    />
    <button
      class="h-11 shrink-0 bg-primary px-3.5 text-ui font-semibold text-primary-ink hover:brightness-110 disabled:cursor-not-allowed disabled:bg-raised disabled:text-muted"
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
