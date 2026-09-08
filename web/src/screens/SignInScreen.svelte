<script lang="ts">
  /**
   * The way in to the teaching side.
   *
   * Two doors, both links, both revocable: a personal sign-in link a teacher
   * was sent, and the setup token from the server's disk — which claims a fresh
   * instance and afterwards stays the way back in for an owner who lost theirs.
   * There is no password to forget, so there is nothing here to reset.
   */
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

  // A token that came in through /admin/t/<token> on an instance nobody owns
  // yet. Filling it in is the whole point of that link: what is left to do is
  // say who you are.
  $effect(() => {
    const offered = adminAuth.offeredSetupToken
    if (offered && !token) token = offered
  })

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
       paints on the first frame while the cards wait for the instance state.
       И организацию оно поэтому не подписывает: строка приезжает в карточке
       семинара, а на этом экране семинара нет — пришлось бы спрашивать её
       отдельным запросом и надписывать постер второй раз, уже нарисованный.
       Цена мала: сюда приходят свои — надпись «кто мы» говорит тем, кого
       позвали по ссылке, а не тем, кто здесь работает. -->
  <Poster title="Teaching workspace" headline="banner" width="hidden w-5/12 xl:flex">
    Create seminars, manage teaching access and configure the oracle here.

    {#snippet footer()}
      <div class="flex items-start gap-2.5">
        <Icon name="lock" size={14} class="mt-1 shrink-0 text-white/60" />
        <p class="text-2xs leading-relaxed text-white/60">
          Students join from a seminar link and enter their name. They do not need a teacher account.
        </p>
      </div>
    {/snippet}
  </Poster>

  <div
    class="flex min-w-0 flex-1 flex-col justify-center gap-[22px] overflow-y-auto px-6 py-12 sm:px-[72px]"
  >
    {#if instance}
      {#if !claimed}
        <section class="animate-fade-up flex flex-col gap-5 border border-line p-[26px]">
          <div class="flex flex-col gap-1.5">
            <p class="text-micro font-bold uppercase tracking-label text-accent-text">
              Initial setup
            </p>
            <h2 class="text-head font-black tracking-tight text-ink">Set up this instance</h2>
            <p class="text-ui text-muted">
              Use the setup token to create the first owner account for this server.
            </p>
          </div>

          <form class="flex flex-col gap-5" onsubmit={claim}>
            <div class="flex flex-col gap-[7px]">
              <label
                for="setup-token"
                class="text-2xs font-bold uppercase tracking-label text-muted"
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
                  class="text-2xs font-bold uppercase tracking-label text-muted"
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
                  class="text-2xs font-bold uppercase tracking-label text-muted"
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
                Sign-in links are shared manually. Email sign-in and university accounts are not supported.
              </p>
            </div>
          </div>
        </section>
      {/if}

      {#if !claimed}
        <!--
          Before anyone owns the instance there is exactly one thing to do, and a
          second card beside it competes with that. What the card says is still
          worth knowing — it is what your colleagues will get — so it stays, as
          one line rather than as a rival.
        -->
        <p class="animate-fade-up text-ui text-muted">
          After setup, add teachers and share their personal sign-in links.
        </p>
      {:else}
      <section class="animate-fade-up flex flex-col gap-[18px] bg-surface p-[26px]">
        <div class="flex flex-col gap-1.5">
          <p class="text-micro font-bold uppercase tracking-label text-muted">
            Teacher access
          </p>
          <h2 class="text-head font-black tracking-tight text-ink">Sign in</h2>
          <p class="text-ui text-muted">
            Open the personal sign-in link an owner gave you. Save the original link to use it again.
            It works until an owner replaces it or removes your account.
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
          <span class="shrink-0 text-micro font-bold uppercase tracking-label text-muted">
            Example
          </span>
        </div>

        <!-- Эта карточка и есть «инстансом уже владеют»: она нарисована в
             ветке `{:else}` от `{#if !claimed}` выше. До того токен — это то,
             чем инстанс присваивают, карточкой выше, и второе поле под ту же
             строку было бы ловушкой, а не восстановлением. -->
        <form class="flex flex-col gap-3 border-t border-line pt-[18px]" onsubmit={recover}>
          <div class="flex flex-wrap items-baseline gap-2">
            <span class="text-ui font-semibold text-ink">Sign in with the setup token</span>
            <label for="recovery-token" class="text-ui text-muted">
              This signs you in as the longest-standing owner.
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
      </section>
      {/if}
    {:else}
      <!--
        Сервер не ответил — и раньше здесь не было ничего.

        Весь правый столбец висел на `{#if instance}`, а состояние инстанса не
        читалось, когда вход по ключу проваливался: ключ из ссылки уже потрачен,
        адресная строка переписана, экран пуст. Отозванный ключ выглядел как
        белая страница, и по ней нельзя было понять ни что случилось, ни что
        делать.
      -->
      <section class="animate-fade-up flex flex-col gap-5 border border-line p-[26px]">
        <div class="flex flex-col gap-1.5">
          <h2 class="text-head font-black tracking-tight text-ink">Could not reach the panel</h2>
          <p class="text-ui text-muted">
            {adminAuth.error ?? 'The server did not answer.'}
          </p>
          <p class="text-ui text-muted">
            Check your connection and try again. If the server remains unavailable, contact the person
            who runs it.
          </p>
        </div>
        <button
          type="button"
          class="btn-outline h-11 self-start px-6 text-2xs font-bold uppercase tracking-caps"
          disabled={adminAuth.loading}
          onclick={() => void adminAuth.refresh()}
        >
          {adminAuth.loading ? 'Trying…' : 'Try again'}
        </button>
      </section>
    {/if}
  </div>
</div>
