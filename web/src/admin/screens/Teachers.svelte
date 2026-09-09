<script lang="ts">
  import { tr, getLocale } from '@shared/i18n'
  /**
   * Who can teach — the staff list, which is really a list of live credentials.
   *
   * A link is never DISPLAYED except in the moment it is minted or rotated —
   * `Teacher` carries `hasLink` and a masked shape, so a screen share in a
   * lecture hall spills nothing. It can still be COPIED afterwards, straight
   * from the server to the clipboard without passing through the DOM, because
   * forcing a rotation on "they lost the link" would kill that person's other
   * devices to solve a problem they did not have.
   *
   * When a link is shown, copying it must be the obvious next act, and closing
   * it must feel like a decision — hence the reveal band, which names what it
   * is, offers one button, and labels its own dismissal "close without copying"
   * until you have.
   *
   * Everything that is not reading the list is owner-only, and the last owner's
   * controls are absent rather than disabled: the server answers 409 either way,
   * and an action you are never allowed to take should not be drawn as one.
   */
  import { onMount } from 'svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { navCounts } from '@/admin/AdminShell.svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import Avatar from '@/components/ui/Avatar.svelte'
  import Icon from '@/components/ui/Icon.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import { cn, relativeTime } from '@/lib/utils'
  import { LIMITS, SIGN_IN_PATH, type AdminRole, type Teacher } from '@shared/admin'
  import { colorForId } from '@shared/protocol'
  import { copyText } from '@/lib/clipboard'
  import { seminarLink } from '@/lib/seminar-link'

  /* The lanes. Declared once so the header and every row cannot drift apart. */
  /*
   * The lanes give way in order, and the name is not first in it. They used to
   * be shrink-0, so the only flexible thing in the row was the person — at
   * 900px that left the name 0px while a masked link nobody can read kept all
   * 322 of its own. Each lane now states the width it wants and the width it
   * can be argued down to; the name states a floor of its own (below) so the
   * argument reaches the link before it reaches the person.
   */
  const COL_ROLE = 'w-[168px] min-w-[110px] pr-4'
  const COL_LINK = 'w-[322px] min-w-[150px] pr-5'
  const COL_SEEN = 'w-[130px] min-w-[100px]'
  const COL_MENU = 'w-10 shrink-0'
  /** The person's own floor — an avatar, a name worth reading, and the gap. */
  const COL_PERSON = 'min-w-[200px] flex-1 pr-5'

  /** All a row may ever show of a live link: its shape. */
  const MASKED = `${location.host}${SIGN_IN_PATH}${'·'.repeat(12)}`

  /**
   * Ссылка входа — от адреса, который коллега сможет открыть.
   *
   * Сервер строит её из PUBLIC_URL, и PUBLIC_URL, оставленный на localhost,
   * отдаёт в чат ссылку, которую не открыть ни с одной другой машины; маска в
   * строке при этом рисуется от `location.host`, то есть форма и содержимое
   * расходятся. Для ссылки семинара это правило уже написано и измерено
   * (lib/seminar-link.ts) — начало адреса берётся у него же, чтобы правило
   * осталось одним на две ссылки, а путь остаётся серверным: в нём ключ.
   */
  function reachable(signInUrl: string): string {
    try {
      const chosen = new URL(seminarLink(signInUrl, location.origin, 'x'))
      const link = new URL(signInUrl)
      return `${chosen.origin}${link.pathname}${link.search}`
    } catch {
      // PUBLIC_URL задаёт оператор, и это может быть что угодно.
      return signInUrl
    }
  }

  interface Reveal {
    teacherId: string
    name: string
    url: string
    /** A brand-new account reads differently from a link that just replaced one. */
    minted: boolean
  }

  let teachers = $state<Teacher[]>([])
  let listErrorText = $state<(() => string | null) | null>(null)
  const listError = $derived(listErrorText?.() ?? null)

  let composing = $state(false)
  let draftName = $state('')
  let draftEmail = $state('')
  let creating = $state(false)
  let composeErrorText = $state<(() => string | null) | null>(null)
  const composeError = $derived(composeErrorText?.() ?? null)

  /** The link, held in this tab only, for as long as the band stays open. */
  let reveal = $state<Reveal | null>(null)
  let copied = $state(false)
  let copyErrorText = $state<(() => string | null) | null>(null)
  const copyError = $derived(copyErrorText?.() ?? null)
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  let linkField = $state<HTMLInputElement | null>(null)

  /** The row whose link was just put on the clipboard, so only that row says so. */
  let copiedRow = $state<string | null>(null)
  let copiedRowTimer: ReturnType<typeof setTimeout> | undefined
  /** Separate from copyError, which lives inside the reveal band and would not be on screen. */
  let rowCopyErrorText = $state<(() => string | null) | null>(null)
  const rowCopyError = $derived(rowCopyErrorText?.() ?? null)

  let confirming = $state<{ id: string; kind: 'rotate' | 'remove' } | null>(null)
  /** The row a destructive call is in flight for; nothing else is disabled by it. */
  let acting = $state<string | null>(null)
  let confirmErrorText = $state<(() => string | null) | null>(null)
  const confirmError = $derived(confirmErrorText?.() ?? null)

  let menuId = $state<string | null>(null)
  let roleBusy = $state<string | null>(null)
  /**
   * Правка имени и адреса, открытая полосой прямо в строке.
   *
   * Раньше опечатка в фамилии лечилась только «удалить и завести заново»: новая
   * ссылка, потерянное авторство семинаров и выброшенный из панели человек ради
   * одной буквы. Черновик держится отдельно от `teachers`, чтобы брошенная
   * правка не перекрашивала строку.
   */
  let newSetupToken = $state<string | null>(null)
  let setupTokenErrorText = $state<(() => string | null) | null>(null)
  const setupTokenError = $derived(setupTokenErrorText?.() ?? null)
  let rotatingSetup = $state(false)
  /** Показан один раз — значит его должно быть чем взять, не выделяя мышью. */
  let copiedSetup = $state(false)
  let copiedSetupTimer: ReturnType<typeof setTimeout> | undefined

  let editing = $state<{ id: string; name: string; email: string } | null>(null)
  let savingEdit = $state(false)
  /** A refusal with no confirmation band to land in still has to be seen. */
  let rowError = $state<{ id: string; message: () => string } | null>(null)

  const me = $derived(adminAuth.me?.teacher ?? null)
  const isOwner = $derived(me?.role === 'owner')
  /*
   * Counted from the list rather than read from `adminAuth.me.ownerCount`, so a
   * promotion that has only just painted is already reflected in what the other
   * rows will let you do.
   */
  const ownerCount = $derived(teachers.filter((t) => t.role === 'owner').length)

  /** True for the person the instance cannot afford to lose. */
  const stranded = (t: Teacher): boolean => t.role === 'owner' && ownerCount <= 1

  onMount(() => {
    void load()
    return () => clearTimeout(copyTimer)
  })

  /**
   * A dead cookie is not a message to print, it is a different screen: asking
   * auth to re-read drops the whole panel back to sign-in.
   */
  function report(cause: unknown): string {
    if (cause instanceof AdminApiError) {
      // С причиной: печенье сюда доехало и его отвергли — ссылку ротировали или
      // из штата сняли. Экран входа скажет именно это, а не про cookies.

      return cause.message
    }
    if (cause instanceof Error) return cause.message
    return tr("admin.the.server.did.not.answer")
  }

  async function load(): Promise<void> {
    try {
      teachers = await adminApi.listTeachers()
      loaded = true
      listErrorText = null
    } catch (cause: unknown) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      listErrorText = () => (report(cause))
    }
  }

  /*
   * Число в боковой навигации — отсюда, как у семинаров и курсов: шелл
   * спрашивает список сам только пока не знает его, а после добавленного или
   * удалённого человека правду знает этот экран.
   */
  let loaded = $state(false)
  $effect(() => {
    if (loaded) navCounts.teachers = teachers.length
  })

  function put(updated: Teacher): void {
    teachers = teachers.map((t) => (t.id === updated.id ? updated : t))
  }

  function openComposer(): void {
    composing = true
    composeErrorText = null
    menuId = null
  }

  async function create(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const name = draftName.trim()
    const email = draftEmail.trim()
    if (!name) return void (composeErrorText = () => (tr("admin.a.name.is.required")))
    if (!email) return void (composeErrorText = () => (tr("admin.enter.an.email.address")))

    creating = true
    composeErrorText = null
    try {
      const minted = await adminApi.createTeacher({ name, email })
      // The list is ordered by creation, so the new row lands at the bottom —
      // which is also where the reveal band it owns will scroll itself into view.
      teachers = [...teachers, minted.teacher]
      composing = false
      draftName = ''
      draftEmail = ''
      show({
        teacherId: minted.teacher.id,
        name: minted.teacher.name,
        url: reachable(minted.signInUrl),
        minted: true,
      })
    } catch (cause: unknown) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      composeErrorText = () => (report(cause))
    } finally {
      creating = false
    }
  }

  /**
   * Optimistic, because a role is the one change here that is cheap to be wrong
   * about: it paints, and a refusal puts it back with the server's own sentence.
   * Rotating and removing are not offered the same courtesy — they end sessions.
   */
  async function setRole(t: Teacher, role: AdminRole): Promise<void> {
    if (role === t.role) return
    const before = t.role
    put({ ...t, role })
    roleBusy = t.id
    rowError = null
    try {
      const updated = await adminApi.updateTeacher(t.id, { role })
      put(updated)
      // Demoting yourself takes the controls off this screen; the shell has to
      // hear about it from the server rather than from us.
      if (updated.id === me?.id) void adminAuth.refresh()
    } catch (cause: unknown) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      put({ ...t, role: before })
      rowError = { id: t.id, message: () => (report(cause)) }
    } finally {
      roleBusy = null
    }
  }

  async function rotateSetup(): Promise<void> {
    rotatingSetup = true
    setupTokenErrorText = null
    copiedSetup = false
    try {
      const { token } = await adminApi.rotateSetupToken()
      newSetupToken = token
    } catch (cause: unknown) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      setupTokenErrorText = () => (report(cause))
    } finally {
      rotatingSetup = false
    }
  }

  async function copySetupToken(token: string): Promise<void> {
    try {
      await copyText(token)
      copiedSetup = true
      clearTimeout(copiedSetupTimer)
      copiedSetupTimer = setTimeout(() => (copiedSetup = false), 2200)
    } catch {
      // Небезопасное происхождение — обычный способ хостить это самому.
      setupTokenErrorText = () => (tr("admin.could.not.copy.the.token.select.it.and.copy.it.manually"))
    }
  }

  function startEdit(t: Teacher): void {
    menuId = null
    confirming = null
    rowError = null
    editing = { id: t.id, name: t.name, email: t.email }
  }

  async function saveEdit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    const draft = editing
    if (!draft) return
    const name = draft.name.trim()
    const email = draft.email.trim()
    if (!name) return void (rowError = { id: draft.id, message: () => (tr("admin.a.name.is.required")) })
    if (!email) {
      return void (rowError = {
        id: draft.id,
        message: () => (tr("admin.enter.an.email.address")),
      })
    }

    savingEdit = true
    rowError = null
    try {
      const updated = await adminApi.updateTeacher(draft.id, { name, email })
      put(updated)
      editing = null
      // Своё имя стоит в шапке панели — оболочка узнаёт его от сервера.
      if (updated.id === me?.id) void adminAuth.refresh()
    } catch (cause: unknown) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      rowError = { id: draft.id, message: () => (report(cause)) }
    } finally {
      savingEdit = false
    }
  }

  function ask(t: Teacher, kind: 'rotate' | 'remove'): void {
    menuId = null
    confirmErrorText = null
    // Nothing to invalidate and nobody to strand: a first mint needs no warning.
    if (kind === 'rotate' && !t.hasLink) return void rotate(t)
    confirming = { id: t.id, kind }
  }

  async function rotate(t: Teacher): Promise<void> {
    // A first mint runs without a confirmation, so it has no band to fail into.
    const banded = confirming?.id === t.id
    acting = t.id
    confirmErrorText = null
    rowError = null
    try {
      const minted = await adminApi.rotateTeacherLink(t.id)
      put(minted.teacher)
      confirming = null
      show({
        teacherId: t.id,
        name: minted.teacher.name,
        url: reachable(minted.signInUrl),
        minted: !t.hasLink,
      })
    } catch (cause: unknown) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      const message = () => report(cause)
      if (banded) confirmErrorText = message
      else rowError = { id: t.id, message }
    } finally {
      acting = null
    }
  }

  async function remove(t: Teacher): Promise<void> {
    acting = t.id
    confirmErrorText = null
    try {
      await adminApi.deleteTeacher(t.id)
      teachers = teachers.filter((x) => x.id !== t.id)
      confirming = null
      if (reveal?.teacherId === t.id) reveal = null
      // They removed themselves: the server has already cleared the cookie in
      // this browser, so the panel must stop pretending otherwise. И сказать об
      // этом надо тем же, чем это было, — своим решением, а не сбоем печенья.
      if (t.id === me?.id) void adminAuth.refresh('removed-self')
    } catch (cause: unknown) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      confirmErrorText = () => (report(cause))
    } finally {
      acting = null
    }
  }

  function show(next: Reveal): void {
    reveal = next
    copied = false
    copyErrorText = null
  }

  /*
   * Fetch-then-copy rather than render-then-copy: the key reaches this tab only
   * as the argument to writeText and is never put in the DOM, so the row goes
   * on showing its masked shape even while it is being sent to someone.
   */
  async function copyExisting(t: Teacher): Promise<void> {
    if (acting) return
    acting = t.id
    rowCopyErrorText = null
    try {
      const { signInUrl } = await adminApi.teacherLink(t.id)
      await copyText(reachable(signInUrl))
      copiedRow = t.id
      clearTimeout(copiedRowTimer)
      copiedRowTimer = setTimeout(() => (copiedRow = null), 2200)
    } catch (err) {
      // Two very different failures land here — the server refusing, and a
      // browser that will not hand out the clipboard on an insecure origin.
      // Rotating is the way out of the second one, so say which happened.
      rowCopyErrorText = () => (err instanceof AdminApiError
          ? err.message
          : tr("admin.could.not.copy.s.link.try.again.replacing.the.link.will.show.a.ne", { p0: t.name }))
    } finally {
      acting = null
    }
  }

  async function copy(url: string): Promise<void> {
    try {
      await copyText(url)
      copied = true
      copyErrorText = null
      // A confirmation that never leaves stops being one.
      clearTimeout(copyTimer)
      copyTimer = setTimeout(() => (copied = false), 2200)
    } catch {
      // An insecure origin or a denied permission. The link is on screen and
      // selectable, so say that instead of swallowing it.
      copyErrorText = () => (tr("admin.could.not.copy.the.link.it.is.selected.copy.it.manually"))
      linkField?.select()
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    if (menuId) return void (menuId = null)
    if (editing) return void (editing = null)
    // Not while the call is in flight: the band is where its answer lands.
    if (confirming && !acting) confirming = null
  }

  /** Focus lands where the typing goes; `autofocus` on an element is not that. */
  function takeFocus(node: HTMLElement): void {
    node.focus()
  }

  /** A link minted for the last row is worthless if it opened below the fold. */
  function bringIntoView(node: HTMLElement): void {
    node.scrollIntoView({ block: 'nearest' })
  }
</script>

<svelte:window onclick={() => (menuId = null)} onkeydown={onKeydown} />

{#snippet addTeacher()}
  <button type="button" class="btn-primary text-2xs font-bold uppercase tracking-caps" onclick={openComposer}>
    <Icon name="plus" size={13} />
    {tr("admin.add.a.teacher")}
  </button>
{/snippet}

<!-- A span, not a p: it also has to sit inside the composer's <label>. -->
{#snippet eyebrow(text: string)}
  <span class="block text-micro font-bold uppercase tracking-label text-muted">{text}</span>
{/snippet}

<AdminPage
  title={tr("admin.who.can.teach")}
  subtitle={tr("admin.manage.teacher.accounts.and.sign.in.links.teachers.can.create.sem")}
  actions={isOwner ? addTeacher : undefined}
>
  {#if composing}
    <form
      onsubmit={create}
      class="my-5 flex flex-wrap items-end gap-3 border border-line bg-surface px-4 py-3.5"
    >
      <label class="min-w-[190px] flex-1">
        {@render eyebrow(tr("admin.name"))}
        <input
          use:takeFocus
          bind:value={draftName}
          maxlength={LIMITS.teacherName}
          placeholder={tr("admin.ada.lovelace")}
          class="field mt-1.5 text-ui"
        />
      </label>
      <label class="min-w-[210px] flex-1">
        {@render eyebrow(tr("admin.email"))}
        <input
          bind:value={draftEmail}
          type="email"
          maxlength={LIMITS.email}
          spellcheck="false"
          placeholder="ada@example.edu"
          class="field mt-1.5 font-mono text-2xs"
        />
      </label>
      <button type="submit" class="btn-primary" disabled={creating}>
        {creating ? tr("admin.creating.a.link") : tr("admin.add.teacher")}
      </button>
      <button type="button" class="btn-ghost" onclick={() => (composing = false)}>{tr("admin.cancel")}</button>
      {#if composeError}
        <p class="w-full text-ui text-danger">{composeError}</p>
      {/if}
      <p class="w-full text-2xs text-muted">
        {tr("admin.this.creates.a.teacher.account.and.a.sign.in.link.you.can.change")}
      </p>
    </form>
  {/if}

  {#if rowCopyError}
    <p role="alert" class="mb-3 border border-danger/40 bg-danger/5 px-4 py-2.5 text-ui text-danger">
      {rowCopyError}
    </p>
  {/if}

  <!--
    The sum of every lane's floor. Past it the list scrolls sideways in the page
    body rather than collapsing further — and it is the row that scrolls, so the
    rules under the rows run the full width of what they are ruling. The notes
    below the list stay at the window's own width: they are prose, and prose
    should never need scrolling to read.
  -->
  <div class="min-w-[600px]">
  <div class="sticky top-0 z-10 flex h-9 items-center border-b border-line bg-canvas">
    <div class={COL_PERSON}>{@render eyebrow(tr("admin.person.1127"))}</div>
    <div class={COL_ROLE}>{@render eyebrow(tr("admin.role.1128"))}</div>
    <div class={COL_LINK}>{@render eyebrow(tr("admin.sign.in.link"))}</div>
    <div class={COL_SEEN}>{@render eyebrow(tr("admin.last.seen"))}</div>
    <div class={COL_MENU}></div>
  </div>

  {#if listError}
    <div class="flex items-center gap-3 py-6">
      <p class="text-ui text-danger">{listError}</p>
      <button type="button" class="btn-outline" onclick={() => void load()}>{tr("admin.try.again")}</button>
    </div>
  {/if}

  {#each teachers as t (t.id)}
    {@const you = t.id === me?.id}
    {@const locked = stranded(t)}
    <div class="flex min-h-[66px] items-center border-b border-line-soft">
      <div class={cn(COL_PERSON, 'flex items-center gap-3')}>
        <Avatar name={t.name} color={colorForId(t.id)} size="md" />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="truncate text-ui-lg font-semibold text-ink">{t.name}</span>
            {#if you}
              <span class="chip bg-accent/10 text-micro font-bold uppercase tracking-label text-accent-text">
                {tr("admin.you")}
              </span>
            {/if}
          </div>
          <p class="truncate font-mono text-2xs text-muted">{t.email}</p>
        </div>
      </div>

      <div class={COL_ROLE}>
        {#if !isOwner}
          <span class="text-ui capitalize text-muted">{tr(`admin.role.${t.role}`)}</span>
        {:else if locked}
          <span class="block text-ui font-semibold text-ink">{tr("admin.owner")}</span>
          <span class="flex items-center gap-1.5 text-2xs text-muted">
            <Icon name="lock" size={11} class="shrink-0" />
            {tr("admin.last.owner.role.required")}
          </span>
        {:else}
          <div class="relative inline-flex items-center">
            <select
              value={t.role}
              disabled={roleBusy === t.id}
              aria-label="{tr("admin.role.for")} {t.name}"
              onchange={(event) => void setRole(t, event.currentTarget.value as AdminRole)}
              class="h-6 cursor-pointer appearance-none bg-transparent pr-5 text-ui text-ink
                     outline-none disabled:opacity-50"
            >
              <option value="owner">{tr("admin.owner")}</option>
              <option value="teacher">{tr("admin.teacher")}</option>
            </select>
            <Icon name="chevron-down" size={11} class="pointer-events-none absolute right-0 text-faint" />
          </div>
        {/if}
      </div>

      <div class={COL_LINK}>
        {#if t.hasLink}
          <div class="flex items-center gap-2">
            <p
              class="min-w-0 flex-1 truncate font-mono text-code text-muted"
              title={tr("admin.the.link.is.masked.here.copy.puts.the.full.sign.in.link.on.your.c")}
            >
              {MASKED}
            </p>
            {#if isOwner}
              <button
                type="button"
                disabled={acting === t.id}
                onclick={() => void copyExisting(t)}
                class="inline-flex h-7 w-7 shrink-0 items-center justify-center border
                       border-line text-faint transition-colors duration-100 hover:border-faint
                       hover:text-ink disabled:opacity-50"
                aria-label={tr('admin.teacher.copyLinkLabel', { name: t.name })}
              >
                <Icon name={copiedRow === t.id ? 'check' : 'copy'} size={13} />
              </button>
            {/if}
          </div>
        {:else if isOwner}
          <button
            type="button"
            disabled={acting === t.id}
            onclick={() => ask(t, 'rotate')}
            class="inline-flex items-center gap-1.5 text-ui font-semibold text-accent-text hover:underline disabled:opacity-50"
          >
            <Icon name="link" size={13} />
            {acting === t.id ? tr("admin.creating") : tr("admin.create.a.link")}
          </button>
        {:else}
          <p class="text-ui text-muted">{tr("admin.no.link.yet")}</p>
        {/if}
      </div>

      <div class={COL_SEEN}>
        {#if t.lastSeenAt}
          <span class="text-ui text-ink">{relativeTime(t.lastSeenAt)}</span>
        {:else}
          <span class="text-ui text-muted">{tr("admin.never")}</span>
        {/if}
      </div>

      <div class={cn(COL_MENU, 'relative flex justify-end')}>
        {#if isOwner}
          <button
            type="button"
            aria-label="{tr("admin.actions.for")} {t.name}"
            aria-expanded={menuId === t.id}
            onclick={(event) => {
              event.stopPropagation()
              menuId = menuId === t.id ? null : t.id
            }}
            class="flex h-6 w-6 items-center justify-center p-1 text-faint transition-colors duration-100 hover:bg-raised hover:text-ink"
          >
            <Icon name="more" size={15} />
          </button>
          {#if menuId === t.id}
            <div
              class="row-menu absolute right-0 top-full z-20 mt-1 w-56 overflow-hidden bg-canvas py-1 shadow-pop"
            >
              <button
                type="button"
                onclick={() => startEdit(t)}
                class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-ui text-ink hover:bg-raised"
              >
                <Icon name="pencil" size={14} class="text-faint" />
                {tr("admin.edit.name.and.email")}
              </button>
              <button
                type="button"
                onclick={() => ask(t, 'rotate')}
                class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-ui text-ink hover:bg-raised"
              >
                <Icon name="link" size={14} class="text-faint" />
                {t.hasLink ? tr("admin.rotate.sign.in.link") : tr("admin.create.a.sign.in.link")}
              </button>
              {#if !locked}
                <button
                  type="button"
                  onclick={() => ask(t, 'remove')}
                  class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-ui text-danger hover:bg-danger/[0.08]"
                >
                  <Icon name="trash" size={14} />
                  {you ? tr("admin.remove.my.account") : tr("admin.remove.from.staff")}
                </button>
              {/if}
            </div>
          {/if}
        {/if}
      </div>
    </div>

    {#if rowError?.id === t.id}
      <p class="border-b border-line-soft py-2.5 pl-11 text-ui text-danger">{rowError.message()}</p>
    {/if}

    {#if editing?.id === t.id}
      <form
        onsubmit={(event) => void saveEdit(event)}
        class="flex flex-wrap items-end gap-3 border-b border-line-soft bg-surface py-4 pl-11 pr-4"
      >
        <label class="min-w-[180px] flex-1">
          {@render eyebrow(tr("admin.name"))}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            autofocus
            bind:value={editing.name}
            maxlength={LIMITS.teacherName}
            class="field mt-1.5 text-ui"
          />
        </label>
        <label class="min-w-[210px] flex-1">
          {@render eyebrow(tr("admin.email"))}
          <input
            bind:value={editing.email}
            type="email"
            maxlength={LIMITS.email}
            spellcheck="false"
            class="field mt-1.5 font-mono text-2xs"
          />
        </label>
        <button type="submit" class="btn-primary" disabled={savingEdit}>
          {savingEdit ? tr("admin.saving") : tr("admin.save")}
        </button>
        <button type="button" class="btn-ghost" onclick={() => (editing = null)}>{tr("admin.cancel")}</button>
        <p class="w-full text-2xs text-muted">
          {tr("admin.this.updates.their.name.and.email.their.sign.in.link.stays.the.sa")}
        </p>
      </form>
    {/if}

    {#if confirming?.id === t.id}
      <div class="border-b border-line-soft bg-surface py-4 pl-11 pr-4">
        {#if confirming.kind === 'rotate'}
          <p class="text-ui-lg font-semibold text-ink">{tr('admin.teacher.rotateHeading', { name: t.name })}</p>
          <p class="mt-1.5 max-w-[640px] text-ui text-muted">
            {tr("admin.the.old.link.will.stop.working.and.their.signed.in.sessions.will")}{you
              ? tr("admin.except.this.browser.session.which.will.be.renewed")
              : ''}{tr("admin.a.new.link.will.appear.here.for.you.to.share")}
          </p>
        {:else}
          <p class="text-ui-lg font-semibold text-ink">
            {you ? tr("admin.remove.your.own.account") : tr("admin.remove.1171", { p0: t.name })}
          </p>
          <p class="mt-1.5 max-w-[640px] text-ui text-muted">
            {tr("admin.their.sign.in.link.will.stop.working.and.their.signed.in.sessions")}{you
              ? tr("admin.including.this.one")
              : ''}{tr("admin.their.seminars.will.remain.adding.them.again.creates.a.new.accoun")}
          </p>
        {/if}
        <div class="mt-3 flex items-center gap-2">
          <button
            type="button"
            disabled={acting === t.id}
            onclick={() => void (confirming?.kind === 'rotate' ? rotate(t) : remove(t))}
            class="btn border border-danger/40 bg-danger/[0.05] text-danger hover:bg-danger/20"
          >
            {#if acting === t.id}
              {tr("admin.working")}
            {:else if confirming.kind === 'rotate'}
              {tr("admin.rotate.the.link")}
            {:else}
              {tr("admin.remove")} {you ? tr("admin.my.account") : t.name}
            {/if}
          </button>
          <button
            type="button"
            class="btn-ghost"
            disabled={acting === t.id}
            onclick={() => (confirming = null)}
          >
            {tr("admin.cancel")}
          </button>
          {#if confirmError}
            <p class="text-ui text-danger">{confirmError}</p>
          {/if}
        </div>
      </div>
    {:else if reveal?.teacherId === t.id}
      {@const shown = reveal}
      <div
        use:bringIntoView
        class="enter border-b border-line-soft border-l-2 border-l-accent bg-accent/5 p-4"
      >
        {@render eyebrow(tr("admin.sign.in.link.for.shown.once", { p0: shown.name }))}
        <!--
          What this says has to match what the page can actually do. The link is
          shown here once and never displayed again — but the copy button in the
          row still puts it on your clipboard, so "gone for good" would be the
          screen lying about itself, and the note at the foot of this page says
          the opposite.
        -->
        <p class="mt-1.5 max-w-[720px] text-ui text-ink">
          {#if shown.minted}
            {shown.name} {tr("admin.is.on.the.staff.list.share.this.personal.sign.in.link.with.them")}
          {:else}
            {tr("admin.the.old.link.has.been.replaced.share.this.new.sign.in.link.with")} {shown.name}.
          {/if}
        </p>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <input
            bind:this={linkField}
            readonly
            value={shown.url}
            spellcheck="false"
            aria-label="{tr("admin.sign.in.link.for")} {shown.name}"
            onfocus={(event) => event.currentTarget.select()}
            class="field min-w-[280px] max-w-[560px] flex-1 bg-canvas font-mono text-code"
          />
          <button type="button" class="btn-primary" onclick={() => void copy(shown.url)}>
            <Icon name={copied ? 'check' : 'copy'} size={14} />
            {copied ? 'Copied' : tr("admin.copy.link")}
          </button>
          <button type="button" class="btn-ghost" onclick={() => (reveal = null)}>
            {copied ? tr("admin.done") : tr("admin.close.without.copying")}
          </button>
        </div>
        {#if copyError}
          <p class="mt-2 text-ui text-danger">{copyError}</p>
        {:else if !copied}
          <p class="mt-2 text-2xs text-muted">
            {tr("admin.after.closing.this.message.use.the.copy.button.on.their.row.to.co")}
          </p>
        {/if}
      </div>
    {/if}
  {/each}
  </div>

  <div class="flex items-center gap-2.5 py-3.5">
    <Icon name="link" size={13} class="shrink-0 text-faint" />
    <p class="text-2xs text-muted">
      {#if isOwner}
        {tr("admin.anyone.with.a.personal.link.can.sign.in.to.that.account.replace.a")}
      {:else}
        {tr("admin.anyone.with.a.personal.link.can.sign.in.to.that.account.contact.a")}
      {/if}
    </p>
  </div>

  <!--
    Токен установки — четвёртая дверь в панель, о которой этот экран молчал.

    Он подписывает вошедшего как самого старого владельца и печатается `make
    host` при каждом запуске: он есть в истории терминала, на снимках проектора
    и в переписке, куда его пересылали. Отозвать его было нечем — а «rotate it
    when someone leaves» выше относилось к ссылкам преподавателей и про эту
    дверь не говорило ничего.
  -->
  {#if isOwner}
    <div class="flex flex-wrap items-start gap-3 border-t border-line-soft py-3.5">
      <div class="min-w-0 max-w-[600px] flex-1">
        {@render eyebrow(tr("admin.setup.token"))}
        <!--
          Печатает токен `make host`, читая его из файла, — не сервер: тот
          молчит, как только у инстанса появился владелец, а этот блок виден
          только владельцу. Обещание «следующий запуск его напечатает» было
          верно ровно там, где его никто не читает.
        -->
        <p class="mt-1.5 text-2xs text-muted">
          {tr("admin.the.setup.token.signs.anyone.holding.it.in.as.the.longest.standin")}
          <span class="font-mono text-2xs text-accent-text">&lt;DATA_DIR&gt;/setup-token</span>.
        </p>
        {#if newSetupToken}
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <p class="min-w-0 break-all font-mono text-2xs text-ink">{newSetupToken}</p>
            <button
              type="button"
              class="btn-ghost shrink-0 text-2xs"
              onclick={() => void copySetupToken(newSetupToken ?? '')}
            >
              {copiedSetup ? 'Copied' : tr("admin.copy")}
            </button>
          </div>
          <p class="mt-1 text-2xs text-muted">
            {tr("admin.the.token.is.also.available.through")} <span class="font-mono">make host</span>{tr("admin.which.reads.it.from")}
            <span class="font-mono text-2xs text-accent-text">&lt;DATA_DIR&gt;/setup-token</span>{tr("admin.the.server.logs.it.only.before.the.first.owner.is.created")}
          </p>
        {:else if setupTokenError}
          <p class="mt-2 text-2xs text-danger">{setupTokenError}</p>
        {/if}
      </div>
      <button
        type="button"
        class="btn-outline shrink-0"
        disabled={rotatingSetup}
        onclick={() => void rotateSetup()}
      >
        {rotatingSetup ? tr("admin.rotating") : tr("admin.rotate.setup.token")}
      </button>
    </div>
  {/if}

  <div class="flex flex-wrap items-start gap-14 border-t border-line-soft pt-5">
    <div class="min-w-0 max-w-[600px] flex-1">
      {@render eyebrow(tr("admin.masked.sign.in.links"))}
      <p class="mt-1.5 text-2xs text-muted">
        {tr("admin.the.list.masks.sign.in.links.a.newly.created.or.replaced.link.is")}
      </p>
    </div>
    <div class="w-[392px]">
      {@render eyebrow(isOwner ? tr("admin.lost.your.own.link") : tr("admin.lost.your.link"))}
      {#if isOwner}
        <p class="mt-1.5 text-2xs text-muted">
          {tr("admin.the.setup.token.in")} <span class="font-mono text-2xs text-accent-text">&lt;DATA_DIR&gt;/setup-token</span>
          {tr("admin.signs.you.in.as.the.longest.standing.current.owner")}
        </p>
      {:else}
        <p class="mt-1.5 text-2xs text-muted">
          {tr("admin.ask.an.owner.to.copy.and.share.your.current.link.if.it.may.have.r")}
        </p>
      {/if}
    </div>
  </div>
</AdminPage>
