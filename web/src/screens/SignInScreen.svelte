<script lang="ts">
  import Icon from '@/components/ui/Icon.svelte'
  import Poster from '@/components/ui/Poster.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { LIMITS } from '@shared/admin'

  /*
   * There is no SSO here and no email is ever sent, so the screen is two cards
   * and no third: FIRST RUN, which the setup token spends exactly once, and
   * RETURNING, which is not a form at all because the way back in is the
   * personal link an owner already sent you. On a fresh install both are on
   * screen — the first says what to do now, the second what happens after it.
   */
  const instance = $derived(adminAuth.state)
  const claimed = $derived(instance?.claimed ?? false)

  let token = $state('')
  let name = $state('')
  let email = $state('')
  let emailTouched = false

  // The prefill arrives with the instance state, a paint after the field does.
  // It fires once and then stands down, so it can never land on top of what the
  // person is already typing.
  $effect(() => {
    const suggested = instance?.suggestedEmail ?? ''
    if (!suggested || emailTouched) return
    emailTouched = true
    email = suggested
  })

  const canClaim = $derived(
    token.trim().length > 0 && name.trim().length > 0 && email.trim().length > 0,
  )

  async function claim(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (!canClaim || adminAuth.loading) return
    await adminAuth.claim({ token: token.trim(), name: name.trim(), email: email.trim() })
  }

  async function recover(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (!token.trim() || adminAuth.loading) return
    await adminAuth.signInWithToken(token.trim())
  }
</script>

<div class="flex h-full">
  <!-- The poster does not depend on anything the server has to say, so it
       paints on the first frame while the cards wait for the instance state. -->
  <div class="hidden shrink-0 xl:flex">
    <Poster title="Teaching workspace" headline="banner" width="w-5/12">
      Seminars and the assistant are configured here — so that the classroom itself stays a link and
      nothing else.

      {#snippet footer()}
        <div class="flex items-start gap-2.5">
          <Icon name="lock" size={14} class="mt-1 shrink-0 text-white/60" />
          <p class="text-2xs leading-relaxed text-white/60">
            Students never reach this screen. They open a seminar link, type a name and are inside —
            no account, ever.
          </p>
        </div>
      {/snippet}
    </Poster>
  </div>

  <div
    class="flex min-w-0 flex-1 flex-col justify-center gap-[22px] overflow-y-auto px-6 py-12 sm:px-[72px]"
  >
    {#if instance}
      {#if !claimed}
        <section class="animate-fade-up flex flex-col gap-5 border border-line p-[26px]">
          <div class="flex flex-col gap-1.5">
            <p class="text-micro font-bold uppercase tracking-label text-accent-text">
              First run · once
            </p>
            <h2 class="text-head font-black tracking-tight text-ink">Set up this instance</h2>
            <p class="text-ui text-muted">
              Nobody owns this install yet. The token claims it and makes you the owner — after that
              this card is gone.
            </p>
          </div>

          <form class="flex flex-col gap-5" onsubmit={claim}>
            <div class="flex flex-col gap-[7px]">
              <label
                for="setup-token"
                class="text-2xs font-bold uppercase tracking-label text-faint"
              >
                Setup token
              </label>
              <input
                id="setup-token"
                bind:value={token}
                class="field h-[46px] bg-canvas px-4 font-mono text-code-lg"
                placeholder="paste the setup token"
                autocomplete="off"
                spellcheck="false"
              />
            </div>

            <div class="flex flex-col gap-3.5 sm:flex-row">
              <div class="flex min-w-0 flex-1 flex-col gap-[7px]">
                <label
                  for="owner-name"
                  class="text-2xs font-bold uppercase tracking-label text-faint"
                >
                  Your name
                </label>
                <input
                  id="owner-name"
                  bind:value={name}
                  class="field h-[46px] bg-canvas px-4 text-ui"
                  placeholder="Alex"
                  maxlength={LIMITS.teacherName}
                  autocomplete="name"
                />
              </div>
              <div class="flex min-w-0 flex-1 flex-col gap-[7px]">
                <label
                  for="owner-email"
                  class="text-2xs font-bold uppercase tracking-label text-faint"
                >
                  Your email
                </label>
                <input
                  id="owner-email"
                  bind:value={email}
                  oninput={() => (emailTouched = true)}
                  class="field h-[46px] bg-canvas px-4 font-mono text-code-lg"
                  placeholder="you@university.edu"
                  maxlength={LIMITS.email}
                  autocomplete="email"
                />
              </div>
            </div>

            {#if adminAuth.error}
              <p class="text-ui text-danger">{adminAuth.error}</p>
            {/if}

            <button
              class="btn-primary h-12 w-full text-2xs font-bold uppercase tracking-caps"
              type="submit"
              disabled={!canClaim || adminAuth.loading}
            >
              {adminAuth.loading ? 'Claiming…' : 'Claim this instance'}
            </button>
          </form>

          <div class="flex items-start gap-2.5">
            <Icon name="code" size={14} class="mt-0.5 shrink-0 text-faint" />
            <div class="flex min-w-0 flex-col gap-[3px] text-2xs text-muted">
              <p>
                Printed in the server log on first boot, and kept in
                <code class="font-mono text-2xs text-accent-text">&lt;DATA_DIR&gt;/setup-token</code>
              </p>
              <p>
                Nothing is emailed and there is no university login to redirect to — this install has
                neither.
              </p>
            </div>
          </div>
        </section>
      {/if}

      <section class="animate-fade-up flex flex-col gap-[18px] bg-surface p-[26px]">
        <div class="flex flex-col gap-1.5">
          <p class="text-micro font-bold uppercase tracking-label text-faint">
            Returning · every time after
          </p>
          <h2 class="text-head font-black tracking-tight text-ink">Sign in</h2>
          <p class="text-ui text-muted">
            There is no form here on purpose. Your personal link is the sign-in — open it, bookmark
            it, and it keeps working until the owner rotates it.
          </p>
        </div>

        <!-- A specimen, not a link: it shows the shape of the credential so the
             person can recognise the one in their chat history. -->
        <div
          class="flex h-[46px] items-center gap-2.5 border border-line bg-canvas px-4"
        >
          <Icon name="link" size={14} class="shrink-0 text-accent-text" />
          <span class="min-w-0 flex-1 truncate font-mono text-ui text-accent-text">
            {window.location.host}/admin/k/&lt;your-key&gt;
          </span>
          <span class="shrink-0 text-micro font-bold uppercase tracking-label text-faint">
            Example
          </span>
        </div>

        {#if claimed}
          <!-- Only once somebody owns the instance: before that the token is
               how you claim it, one card up, and a second field for the same
               string would be a trap rather than a recovery. -->
          <form class="flex flex-col gap-3 border-t border-line pt-[18px]" onsubmit={recover}>
            <div class="flex flex-wrap items-baseline gap-2">
              <span class="text-ui font-semibold text-ink">Lost your link, or you are the owner?</span
              >
              <label for="recovery-token" class="text-ui text-muted">
                Paste the setup token instead.
              </label>
            </div>

            <div class="flex flex-col gap-2.5 sm:flex-row">
              <input
                id="recovery-token"
                bind:value={token}
                class="field h-11 bg-canvas px-4 font-mono text-code-lg"
                placeholder="setup token"
                autocomplete="off"
                spellcheck="false"
              />
              <!-- Outlined, so the primary action on this screen stays the link
                   the person was told to use rather than the fallback. -->
              <button
                class="btn h-11 shrink-0 border border-primary bg-canvas px-6 text-2xs font-bold uppercase tracking-caps text-primary hover:bg-raised sm:w-[150px]"
                type="submit"
                disabled={!token.trim() || adminAuth.loading}
              >
                {adminAuth.loading ? 'Signing in…' : 'Sign in'}
              </button>
            </div>

            {#if adminAuth.error}
              <p class="text-ui text-danger">{adminAuth.error}</p>
            {/if}
          </form>
        {/if}
      </section>
    {/if}
  </div>
</div>
