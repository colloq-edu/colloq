<script lang="ts">
  /**
   * The way in: the first step of a competition's «Посылки» tab for a visitor
   * who has not joined it, in the place where the send box stands for those
   * who have (P2). Every «Участвовать» on the competition's pages and on its
   * card in the list leads here (join-step.ts says why it is not a form under
   * the card any more).
   *
   * Two ways in, side by side, as on P1: a name for a newcomer, the saved key
   * for someone who joined from another device. A signed-in person sees only
   * the first, with the name they carry already filled in. When the door
   * takes nobody now (before the start, after the deadline), the step says
   * why, and the key stays for those who are in already.
   */
  import { tick } from 'svelte'
  import { tr } from '@shared/i18n'
  import { LIMITS, acceptsUploads, nameForJoin } from '@shared/competitions'
  import type { Accepting } from '@shared/competitions-entrant'
  import KeySignIn from './KeySignIn.svelte'
  import { joinFocusTarget } from './join-step'

  interface Props {
    accepting: Accepting
    /** The name the person already carries: filled in, and accepted back untouched. '' — a stranger. */
    defaultName: string
    /** A person with an identity on this server: there is no key to sign in with here. */
    signedIn: boolean
    busy: boolean
    refusal: string | null
    signInBusy: boolean
    signInRefusal: string | null
    /** «Участвовать» was pressed on another tab or in the list: take the focus once, then say so. */
    focus: boolean
    onfocused: () => void
    onjoin: (name: string) => void
    onsignin: (key: string) => void
  }

  const {
    accepting,
    defaultName,
    signedIn,
    busy,
    refusal,
    signInBusy,
    signInRefusal,
    focus,
    onfocused,
    onjoin,
    onsignin,
  }: Props = $props()

  /* The door takes people while it takes notebooks, late ones included. */
  const open = $derived(acceptsUploads(accepting))

  let name = $state('')
  /*
   * Filled in with the name the person already joined under: a second
   * competition should not ask for it again. Only while the field is
   * untouched — otherwise the effect would overwrite what is being typed.
   */
  let typed = false
  $effect(() => {
    if (!typed && defaultName) name = defaultName
  })

  /*
   * Checked here by the door's own function (shared/competitions.ts ·
   * nameForJoin): a Telegram username or an email, or the name the person
   * already carries sent back untouched — so someone who joined as "Anna
   * Kim" before the rule is not stopped at the second competition by the
   * name the form itself filled in. A name that will not pass never leaves
   * the browser: the refusal is the door's sentence without the round trip.
   *
   * While the person is still typing, the rule is a hint in grey; once they
   * leave the field or press JOIN with a name that will not do, it is a
   * refusal in red — red from the first keystroke would scold "@i" for not
   * yet being "@ivan". JOIN itself stays pressable: a dim button would
   * swallow Enter without a word, exactly when the person wants to hear why.
   */
  const invalid = $derived(name.trim() !== '' && nameForJoin(name, defaultName || null) === null)
  let touched = $state(false)

  let box = $state<HTMLElement | null>(null)
  let field = $state<HTMLInputElement | null>(null)
  let action = $state<HTMLButtonElement | null>(null)
  let keyField = $state<HTMLInputElement | null>(null)

  /*
   * The focus, asked for once: the step is scrolled into view, its first
   * field or its one action takes the cursor, and the page is told, so a
   * later visit to the tab does not steal the focus again.
   *
   * After the DOM has caught up (`tick`), not in the same flush: the name a
   * signed-in person carries is filled in by the effect above, and JOIN is
   * still disabled in the DOM until that lands — a disabled button refuses
   * the focus without a word, and the step was left with nothing focused.
   */
  $effect(() => {
    if (!focus || !box) return
    const step = box
    void tick().then(() => {
      const target = joinFocusTarget({ accepting, signedIn, name })
      const element = target === 'name' ? field : target === 'action' ? action : target === 'key' ? keyField : null
      step.scrollIntoView({ block: 'nearest' })
      element?.focus({ preventScroll: true })
      onfocused()
    })
  })
</script>

<section
  bind:this={box}
  class="flex flex-col border-[1.5px] border-brand-2 bg-surface lg:flex-row"
  aria-labelledby="competition-join-title"
  data-join-step
>
  <div class="flex min-w-0 grow flex-col px-4 py-4 sm:px-6 sm:py-5">
    {#if open}
      <form
        class="flex flex-col gap-2"
        onsubmit={(event) => {
          event.preventDefault()
          if (!name.trim()) return
          if (invalid) {
            touched = true
            return
          }
          onjoin(name.trim())
        }}
      >
        <h2 id="competition-join-title" class="text-title font-bold leading-6 text-ink">
          {tr('competitions.p.joinTitle')}
        </h2>
        <!-- Past the deadline the name is no promise of a row on the board:
             late submissions never reach it (C1). The step says so itself:
             the late card's "outside the standings" stays on the list, and
             its JOIN leads here. -->
        <p id="competition-join-hint" class="text-ui leading-5 text-muted">
          {tr(accepting === 'late' ? 'competitions.p.joinLateHint' : 'competitions.p.joinHint')}
        </p>
        <label class="pt-2 text-2xs font-bold text-ink" for="competition-join-name">
          {tr('competitions.handle.label')}
        </label>
        <div class="flex flex-col gap-2 sm:flex-row">
          <!-- `inputmode="email"` puts "@" on a phone's first keyboard page,
               which both kinds of name start or hinge on; `type` stays text,
               since "@ivan_petrov" is no address to a browser. -->
          <input
            id="competition-join-name"
            bind:this={field}
            class="h-11 min-w-0 grow border border-line bg-canvas px-3 text-ui text-ink placeholder:text-faint focus:border-accent focus:outline-none"
            placeholder={tr('competitions.handle.placeholder')}
            aria-describedby={invalid ? 'competition-join-hint competition-join-rule' : 'competition-join-hint'}
            aria-invalid={invalid && touched}
            bind:value={name}
            oninput={() => (typed = true)}
            onblur={() => (touched = invalid)}
            maxlength={LIMITS.entrantName}
            inputmode="email"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
          />
          <button
            bind:this={action}
            class="h-11 shrink-0 bg-brand px-6 text-micro font-black uppercase tracking-label text-white hover:bg-brand-2 disabled:bg-faint"
            type="submit"
            disabled={!name.trim() || busy}
          >
            {tr('competitions.p.join')}
          </button>
        </div>
        {#if invalid}
          <p
            id="competition-join-rule"
            class="text-micro leading-[18px] {touched ? 'text-danger' : 'text-muted'}"
          >
            {tr('competitions.refusal.nameNotHandle')}
          </p>
        {:else if refusal}
          <p class="text-micro leading-[18px] text-danger" role="alert">{refusal}</p>
        {/if}
      </form>
    {:else}
      <h2 id="competition-join-title" class="text-title font-bold leading-6 text-ink">
        {tr(accepting === 'not_open' ? 'competitions.refusal.notOpen' : 'competitions.refusal.closed')}
      </h2>
    {/if}
  </div>

  {#if !signedIn}
    <div
      class="flex shrink-0 flex-col gap-2 border-t border-line px-4 py-4 sm:px-6 sm:py-5 lg:w-[360px] lg:border-l lg:border-t-0"
    >
      <KeySignIn id="competition-join-key-title" busy={signInBusy} refusal={signInRefusal} {onsignin} bind:field={keyField} />
      <p class="text-micro leading-5 text-muted">{tr('competitions.p.joinHaveKey')}</p>
    </div>
  {/if}
</section>
