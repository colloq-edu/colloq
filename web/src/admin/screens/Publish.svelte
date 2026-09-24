<!--
  Publishing a seminar.

  A screen, not a window over the list: the panel has its own rule for this —
  "anything that needs a decision gets a screen of its own". Here you decide
  what the class will be reading a week later, and it cannot be taken back —
  the link cannot be taken away from the students.
-->
<script lang="ts">
  import { tr, getLocale } from '@shared/i18n'
  import { onMount } from 'svelte'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import { AdminApiError, addressHolderOf, adminApi } from '@/lib/adminApi'
  import { skippedStepLine } from '@/admin/panel'
  import { plural } from '@/lib/plural'
  import {
    MAX_STEP_LABEL,
    slugOk,
    suggestSlug,
    type AddressHolder,
    type PublishCandidate,
    type SkippedStep,
  } from '@shared/publish'

  interface Props {
    sessionId: string
    navigate: (path: string) => void
  }

  /** The whole `publishInfo` response — so the page's shape is not redeclared here. */
  type PublishInfo = Awaited<ReturnType<typeof adminApi.publishInfo>>

  let { sessionId, navigate }: Props = $props()

  let title = $state('')
  let candidates = $state<PublishCandidate[]>([])
  /**
   * The already published page — exactly the shape that arrives in the
   * response.
   *
   * The screen no longer has a declaration of its own. It appeared for the
   * sake of `former` (former names in the address): the server sent them,
   * but the call's type did not know about them, and the screen described
   * the page a second time so there was something to release a former name
   * with. Now the field sits in `lib/adminApi.ts` (publishInfo · former),
   * and a copy here would only be one more chance to diverge from the server
   * on the next field.
   */
  let already = $state<PublishInfo['publication']>(null)
  /** The marked steps and their names — by version number. */
  let labels = $state<Record<number, string>>({})
  let picked = $state<Record<number, boolean>>({})
  let errorText = $state<(() => string | null) | null>(null)
  const error = $derived(errorText?.() ?? null)
  let busy = $state(false)
  let done = $state<string | null>(null)
  /**
   * Marked moments that did not become steps — from the server, by name.
   *
   * The response carries them in a separate field (shared/publish.ts ·
   * SkippedStep) precisely because they used to be nowhere: an empty or
   * unreadable version silently dropped out of the publication, and seven
   * marked moments turned into six steps without a single word about which
   * one went missing.
   */
  let skipped = $state<SkippedStep[]>([])

  onMount(() => {
    void adminApi
      .publishInfo(sessionId)
      .then((body) => {
        title = body.title
        candidates = body.candidates
        already = body.publication
        /*
         * Former names come from the server, not only the ones renamed in
         * this tab. A page is renamed on a Monday, and the address is freed
         * in September of the following year: until now the list was empty
         * for anyone who simply opened the screen, and there was nothing in
         * it to release.
         */
        former = already?.former ?? []
        /*
         * The current address comes from the server, not invented anew.
         *
         * The screen did not know it at all: after republishing it filled in
         * a suggestion from the title and kept the "Name the address" button
         * active, so one press changed the address dictated to the class a
         * week earlier — and after that nobody could find the old name.
         */
        slug = body.publication?.slug ?? ''
        slugDraft = slug
        /*
         * Named moments are marked right away — that is what they were named
         * for. Unnamed ones are not marked and cannot be until words are
         * typed into the field: "Snapshot #14" in a student's rail is not the
         * name of a moment but an admission that someone forgot to name it.
         */
        const previous = new Map(body.publication?.steps.map((s) => [s.seq, s.label]) ?? [])
        for (const candidate of body.candidates) {
          const label = previous.get(candidate.seq) ?? candidate.label
          labels[candidate.seq] = label
          picked[candidate.seq] = label.length > 0
        }
      })
      .catch((cause) =>
        (errorText = () => (cause instanceof AdminApiError ? cause.message : tr("admin.could.not.load.the.seminar.history.try.reloading.the.page"))),
      )
  })

  const chosen = $derived(
    candidates.filter((c) => picked[c.seq] && (labels[c.seq] ?? '').trim().length > 0),
  )
  /** One moment means one page. In the first semester that is the usual case. */
  const lone = $derived(candidates.length === 0)

  async function publish(): Promise<void> {
    busy = true
    errorText = null
    try {
      const body = await adminApi.publish(
        sessionId,
        chosen.map((c) => ({ seq: c.seq, label: labels[c.seq].trim(), at: c.at })),
      )
      done = body.publication.id
      skipped = body.skipped ?? []
      // Republishing keeps the address — show the one there is.
      slug = body.publication.slug ?? slug
    } catch (cause) {
      errorText = () => (cause instanceof AdminApiError ? cause.message : tr("admin.could.not.publish.the.seminar.try.again"))
    } finally {
      busy = false
    }
  }

  /** The address name a person chose; suggested from the seminar's title. */
  let slug = $state('')
  let slugDraft = $state('')
  $effect(() => {
    if (done && !slugDraft) slugDraft = suggestSlug(title)
  })

  /**
   * Names this page has already lived under.
   *
   * The server remembers a former name: `setPublicationSlug` puts it into
   * `publish_addresses`, and `findPublication` finds the page by it
   * (server/src/publish/store.ts · moveAddress, findPublication). There used
   * to be a confirm here promising the opposite — "the address /p/week-01
   * will stop opening" — and the teacher either gave up the rename because
   * of a threat that did not exist, or went to re-dictate to the class an
   * address that works anyway.
   *
   * The list comes with the publication response and is extended by renames
   * made here: a screen opened a year later knows exactly what the server
   * knows — otherwise there would be nothing in it to release.
   */
  let former = $state<string[]>([])

  /**
   * The page in question: just published or one that already existed.
   *
   * Former names belong to IT, not to today's press of "Publish": their
   * owner releases them, and here is the owner's id.
   */
  const pageId = $derived(done ?? already?.id ?? null)

  /**
   * The name that was refused, and who holds it.
   *
   * An "already taken" refusal comes in two quite different kinds. Another
   * page's live address is a dead end: only its owner can free it. But a
   * former name, kept for the sake of a link that was handed out, can be
   * released — and whoever it belongs to has the right to release it
   * (server/src/publish/store.ts · releaseFormerSlug). While the server does
   * not name the holder, this stays null and the screen behaves as before:
   * it repeats the refusal phrase and offers nothing.
   */
  let held = $state<{ slug: string; holder: AddressHolder } | null>(null)
  /** Step two: releasing a former address is irreversible, so it is asked aloud. */
  let asking = $state(false)

  async function saveSlug(): Promise<void> {
    if (!done || busy) return
    const next = slugDraft.trim().toLowerCase()
    if (next && !slugOk(next)) {
      errorText = () => (tr("admin.address.3.64.lowercase.latin.letters.digits.or.dashes.start.and.e"))
      return
    }
    busy = true
    errorText = null
    held = null
    try {
      await adminApi.setSlug('publication', done, next || null)
      // The former name stays an address, and the new one stops being
      // anyone's former name — in the same move as on the server.
      const was = slug
      slug = next
      former = [...new Set([...former, was].filter((name) => name && name !== next))]
    } catch (cause) {
      errorText = () => (cause instanceof AdminApiError ? cause.message : tr("admin.could.not.save.the.address.try.again"))
      const holder = addressHolderOf(cause)
      // Only a former one: a live address is not released from here; a
      // rename takes it down.
      if (holder?.former && next) held = { slug: next, holder }
    } finally {
      busy = false
    }
  }

  /**
   * Release a former address and take it — as one decision.
   *
   * One, because it is released precisely to give that name to your own
   * page: two presses in a row would leave a "the name belongs to nobody"
   * state in between, in which anyone else could take it.
   */
  async function release(): Promise<void> {
    if (!held || busy) return
    const { holder, slug: freed } = held
    busy = true
    errorText = null
    try {
      await adminApi.releaseFormerSlug(holder.kind, holder.id, freed)
    } catch (cause) {
      errorText = () => (cause instanceof AdminApiError ? cause.message : tr("admin.could.not.release.the.previous.address.try.again"))
      return
    } finally {
      busy = false
    }
    held = null
    asking = false
    slugDraft = freed
    await saveSlug()
  }

  /**
   * Release your own former name.
   *
   * A different action from the one above, although the route is the same:
   * there the name is taken for yourself, here it is simply released. The
   * only thing that will happen for sure is that the link with this address
   * stops opening, and there is nothing to bring it back with; hence a
   * second step, and the cost is named both at the button and in the
   * question.
   */
  let dropping = $state<string | null>(null)

  async function dropFormer(): Promise<void> {
    const page = pageId
    const name = dropping
    if (!page || !name || busy) return
    busy = true
    errorText = null
    try {
      await adminApi.releaseFormerSlug('publication', page, name)
    } catch (cause) {
      errorText = () => (cause instanceof AdminApiError ? cause.message : tr("admin.could.not.release.the.previous.address.try.again"))
      return
    } finally {
      busy = false
    }
    former = former.filter((was) => was !== name)
    dropping = null
  }

  const stamp = (at: number): string =>
    new Date(at).toLocaleString(getLocale(), {
      hour: '2-digit',
      minute: '2-digit',
      day: 'numeric',
      month: 'long',
    })

  /** What to call a moment missing from the page: its time from the version feed. */
  const momentOf = (seq: number): string | undefined => {
    const candidate = candidates.find((c) => c.seq === seq)
    return candidate ? stamp(candidate.at) : undefined
  }

  /** Escape closes the question — but not in the middle of a server response. */
  function onKey(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || busy) return
    if (asking) asking = false
    else if (dropping) dropping = null
  }

  const YES = 'M1 5.2L4.6 8.8L12 1.4'
  const NO = 'M1.6 1.6L11.4 11.4M11.4 1.6L1.6 11.4'
  const FACT = 'flex items-center gap-3.5 border-b border-line-soft px-3.5 py-2 last:border-b-0'
</script>

<svelte:window onkeydown={onKey} />

<!--
  The page's former addresses — as a list, and something can be done with
  them.

  Renaming does not cancel a link that has been handed out: the old name stays
  this page's address forever — and holds it against everyone else too, so
  next year's page can no longer be given that name. The owner releases them,
  one at a time, and the cost is named right above the button, not only in
  the question after it: the link written in last year's group chat stops
  opening.

  One snippet for both places (a page just published — and a page published
  earlier): the list of former names is one and the same, and two pieces of
  markup would diverge on the very first edit of the wording.
-->
{#snippet formerNames()}
  {#if former.length > 0}
    <div class="border-t border-line pt-3">
      <p class="text-ui font-semibold text-ink">{tr("admin.previous.addresses")}</p>
      <p class="mt-0.5 text-2xs leading-snug text-muted">
        {tr("admin.these.links.open.the.current.publication.releasing.an.address.sto")}
      </p>
      <div class="mt-2 flex flex-col">
        {#each former as name (name)}
          <div class="flex items-center gap-3 border-b border-line-soft py-1.5 last:border-b-0">
            <span class="min-w-0 flex-1 truncate font-mono text-2xs text-ink">/p/{name}</span>
            <button
              type="button"
              class="btn-outline h-9 shrink-0 px-3 text-2xs"
              disabled={busy}
              onclick={() => (dropping = name)}
            >
              {tr("admin.release")}
            </button>
          </div>
        {/each}
      </div>
    </div>
  {/if}
{/snippet}

<AdminPage
  title={done ? tr("admin.published.795") : tr("admin.publish.796", { p0: title })}
  subtitle={done
    ? tr("admin.publishing.again.updates.the.page.at.the.same.link")
    : already
      ? tr("admin.previously.published.p.publishing.again.keeps.the.same.link", { p0: already.slug ?? already.id })
      : tr("admin.choose.notebook.versions.to.publish")}
>
  {#snippet actions()}
    <button type="button" class="btn-ghost" onclick={() => navigate('/admin')}>
      {done ? tr("admin.back.to.list") : tr("admin.cancel")}
    </button>
    {#if !done}
      <button type="button" class="btn-primary" disabled={busy} onclick={() => void publish()}>
        {tr("admin.publish.803")}
      </button>
    {/if}
  {/snippet}

  <div class="px-8 py-6">
    {#if error}
      <p class="pb-4 text-ui text-danger">{error}</p>
    {/if}

    {#if done}
      <div class="flex max-w-[640px] flex-col gap-3 border border-line bg-surface p-5">
        <p class="text-ui text-muted">{tr("admin.published.page")}</p>
        <a
          class="block font-mono text-ui-lg text-accent-text"
          href={`/p/${slug || done}`}
          target="_blank"
          rel="noreferrer"
        >
          {location.host}/p/{slug || done}
        </a>
        <!--
          The address is dictated out loud and written on the board: eight
          random characters are harder to remember than "week-05", and people
          ask for them to be repeated more often. The old address keeps
          working — a link that has already been given out must not break.
        -->
        <div class="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <span class="font-mono text-2xs text-muted">{location.host}/p/</span>
          <input
            class="h-9 w-[220px] border border-line bg-canvas px-2 font-mono text-2xs text-ink
                   placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-accent/40"
            placeholder={done}
            maxlength={64}
            bind:value={slugDraft}
            onkeydown={(event) => {
              if (event.key === 'Enter') void saveSlug()
            }}
          />
          <button
            type="button"
            class="btn-primary h-9 px-3 text-2xs"
            disabled={busy || slugDraft.trim() === slug}
            onclick={() => void saveSlug()}
          >
            {slug ? tr("admin.change.address") : tr("admin.set.address")}
          </button>
          <!-- The name is held not by a live page but by the memory of a link
               that was handed out — and that is the only kind of "taken" the
               owner can resolve themselves. The button sits right here, by
               the field: looking for it elsewhere on the screen means not
               finding it at all. -->
          {#if held}
            <button
              type="button"
              class="btn-outline h-9 px-3 text-2xs"
              disabled={busy}
              onclick={() => (asking = true)}
            >
              {tr("admin.release.previous.address")}
            </button>
          {/if}
          <!-- The id always leads here: whoever dictated /p/xxxx to the class
               before the page got a name should not have to ask again.
               Former NAMES are below, in a separate list: something can also
               be done with them. -->
          {#if slug}
            <span class="text-2xs text-muted">{tr("admin.the.old.address.p")}{done} {tr("admin.also.works")}</span>
          {/if}
        </div>

        {#if held}
          <p class="text-2xs leading-snug text-muted">
            <span class="font-mono text-ink">/p/{held.slug}</span> {tr("admin.the.previous.address.of.the.page")}
            {#if held.holder.name}«{held.holder.name}»{/if}{tr("admin.after.transfer.this.link.will.open.the.current.publication.instea")}
          </p>
        {/if}

        {@render formerNames()}
      </div>

      <!--
        What was marked but will not be on the page.

        Below the link and as a separate block: the link is the result, and
        this is a caveat to it, which must not go unsaid. It used to be
        missing entirely — seven marked moments turned into six steps, and the
        teacher counted the rail by eye.
      -->
      {#if skipped.length > 0}
        <div class="mt-4 max-w-[640px] border-l-[3px] border-warning bg-surface px-4 py-3">
          <p class="text-ui font-semibold text-ink">
            {tr("admin.count.skippedMoments", { count: skipped.length })}
          </p>
          <ul class="mt-1.5 flex flex-col gap-1">
            {#each skipped as step (`${step.seq}:${step.reason}`)}
              <li class="text-ui leading-relaxed text-muted">
                {skippedStepLine(step, momentOf(step.seq))}
              </li>
            {/each}
          </ul>
          <p class="mt-2 text-2xs leading-snug text-faint">
            {tr("admin.the.remaining.steps.were.published.once.the.issue.is.resolved.you")}
          </p>
        </div>
      {/if}
    {:else}
      <!-- Steps -->
      <div class="flex flex-wrap items-start gap-x-7 gap-y-3 border-b border-line pb-6">
        <div class="w-[220px] shrink-0">
          <p class="text-ui font-semibold text-ink">{tr("admin.steps.825")}</p>
          <p class="mt-0.5 text-2xs leading-snug text-muted">
            {tr("admin.saved.notebook.versions.with.code.notes.and.cell.outputs")}
          </p>
        </div>

        {#if lone}
          <!--
            The only place in the product that explains at all why to press
            "Checkpoint". In the first semester this will be the usual case:
            nobody set checkpoints, because nobody said what they are for.
          -->
          <div class="min-w-0 flex-1 border border-line bg-surface px-5 py-4">
            <p class="text-ui-lg font-semibold text-ink">
              {tr("admin.no.saved.versions.to.choose.from.the.current.notebook.will.be.pub")}
            </p>
            <p class="mt-2 text-ui leading-relaxed text-muted">
              {tr("admin.steps.come.from.checkpoints.click")} <span class="font-semibold text-ink">{tr("admin.checkpoint")}</span>
              {tr("admin.in.the.version.history.to.save.the.notebook.at.a.key.point.in.the")}
            </p>
          </div>
        {:else}
          <div class="min-w-0 flex-1 border border-line">
            {#each candidates as candidate (candidate.seq)}
              {@const named = (labels[candidate.seq] ?? '').trim().length > 0}
              <div
                class="flex items-center gap-3.5 border-b border-line-soft px-4 py-2.5 last:border-b-0"
                class:bg-surface={!named}
              >
                <button
                  type="button"
                  class="flex h-[15px] w-[15px] shrink-0 items-center justify-center border
                         {picked[candidate.seq] && named
                    ? 'border-brand bg-brand text-white'
                    : 'border-faint bg-canvas'}"
                  aria-pressed={picked[candidate.seq] && named}
                  aria-label={tr("admin.include.this.version.in.the.publication")}
                  disabled={!named}
                  onclick={() => (picked[candidate.seq] = !picked[candidate.seq])}
                >
                  {#if picked[candidate.seq] && named}
                    <svg width="9" height="7" viewBox="0 0 13 10" fill="none">
                      <path
                        d={YES}
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  {/if}
                </button>
                <span class="w-[128px] shrink-0 font-mono text-2xs text-muted">
                  {stamp(candidate.at)}
                </span>
                <span class="w-[86px] shrink-0 font-mono text-2xs text-faint">
                  {candidate.cellCount} {tr("admin.cells")}
                </span>
                {#if named}
                  <input
                    class="min-w-0 flex-1 border border-transparent bg-transparent px-2 py-1 text-ui text-ink
                           hover:border-line focus:border-line focus:outline-none"
                    maxlength={MAX_STEP_LABEL}
                    bind:value={labels[candidate.seq]}
                  />
                {:else}
                  <input
                    class="min-w-0 flex-1 border border-line bg-canvas px-2 py-1 text-ui text-ink
                           placeholder:text-faint focus:outline-none"
                    placeholder={tr("admin.version.name")}
                    maxlength={MAX_STEP_LABEL}
                    bind:value={labels[candidate.seq]}
                    oninput={() => (picked[candidate.seq] = true)}
                  />
                {/if}
              </div>
            {/each}

            <!-- The last page is always there: without it the publication
                 would be a story of the class that breaks off in the middle. -->
            <div class="flex items-center gap-3.5 border-t border-line bg-surface px-4 py-2.5">
              <span class="flex h-[15px] w-[15px] shrink-0 items-center justify-center bg-faint text-white">
                <svg width="9" height="7" viewBox="0 0 13 10" fill="none">
                  <path d={YES} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </span>
              <span class="w-[128px] shrink-0 font-mono text-2xs text-muted">{tr("admin.now")}</span>
              <span class="w-[86px] shrink-0"></span>
              <span class="min-w-0 flex-1 px-2 text-ui text-muted">
                {tr("admin.notebook.at.the.time.of.publishing")}
                <span class="pl-2 text-2xs text-faint">{tr("admin.always.included.in.the.publication")}</span>
              </span>
            </div>
          </div>
        {/if}
      </div>

      <!-- What becomes public -->
      <div class="flex flex-wrap items-start gap-x-7 gap-y-3 border-b border-line py-6">
        <div class="w-[220px] shrink-0">
          <p class="text-ui font-semibold text-ink">{tr("admin.what.becomes.public")}</p>
          <p class="mt-0.5 text-2xs leading-snug text-muted">
            {tr("admin.names.and.personal.data.in.cell.text.or.outputs.will.be.kept.revi")}
          </p>
        </div>
        <div class="min-w-0 flex-1 border border-line bg-surface">
          {#each [[tr("admin.cells.code.and.notes"), tr("admin.as.they.were.at.each.step")], [tr("admin.everything.the.cells.printed"), tr("admin.charts.tables.and.tracebacks")], [tr("admin.a.copy.button.for.each.cell.and.the.whole.notebook.as.an.ipynb.fi"), tr("admin.so.the.code.can.be.downloaded")]] as [what, why] (what)}
            <div class={FACT}>
              <svg width="13" height="10" viewBox="0 0 13 10" fill="none" class="shrink-0">
                <path d={YES} stroke="#1B7A4B" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span class="min-w-0 flex-1 text-ui text-ink">{what}</span>
              <span class="w-[300px] shrink-0 text-2xs text-muted">{why}</span>
            </div>
          {/each}
          {#each [[tr("admin.who.typed.or.ran.what"), tr("admin.action.authorship.is.not.published")], [tr("admin.oracle.question.history"), tr("admin.questions.and.answers.are.not.published")], [tr("admin.terminal"), tr("admin.command.history.is.not.published")], [tr("admin.room.files"), tr("admin.files.are.not.included.in.the.publication")]] as [what, why] (what)}
            <div class="{FACT} border-t border-line">
              <svg width="13" height="13" viewBox="0 0 13 13" fill="none" class="shrink-0">
                <path d={NO} stroke="#8E2334" stroke-width="1.7" stroke-linecap="round" />
              </svg>
              <span class="min-w-0 flex-1 text-ui text-ink">{what}</span>
              <span class="w-[300px] shrink-0 text-2xs text-muted">{why}</span>
            </div>
          {/each}
        </div>
      </div>

      <!-- The link -->
      <div class="flex flex-wrap items-start gap-x-7 gap-y-3 py-6">
        <div class="w-[220px] shrink-0">
          <p class="text-ui font-semibold text-ink">{tr("admin.the.link")}</p>
          <p class="mt-0.5 text-2xs leading-snug text-muted">{tr("admin.share.the.link.with.your.students")}</p>
        </div>
        <div class="flex min-w-0 max-w-[700px] flex-1 flex-col gap-3">
          {#if already}
            <!-- The same address as in the subtitle: the name that was set IS
                 the link the class was given, and the id next to it would
                 read as a second address of the same page. -->
            <p class="font-mono text-ui-lg text-ink">
              {location.host}/p/{already.slug ?? already.id}
            </p>
            <!-- Here too: a page published last semester is opened here
                 precisely to sort out its addresses, not to publish it
                 again. -->
            {@render formerNames()}
          {/if}
          <p class="text-ui leading-relaxed text-muted">
            {tr("admin.publishing.again.keeps.the.link.after.withdrawal.the.link.display")}
          </p>
          <div class="border-l-[3px] border-warning bg-surface px-4 py-3">
            <p class="text-ui leading-relaxed text-muted">
              <span class="font-semibold text-ink">{tr("admin.room.access.stays.the.same")}</span>
              {tr("admin.publishing.and.archiving.do.not.change.access.through.the.link")} <span class="font-mono">/s/{sessionId}</span>{tr("admin.entry.and.editing.depend.on.the.current.room.rules.and.class.stat")}
            </p>
          </div>
        </div>
      </div>
    {/if}
  </div>
</AdminPage>

<!--
  Releasing a former address — with a question, not a single press.

  The only irreversible action on this screen: a link already dictated to the
  class answers 404 after this, and there is nothing to bring it back with.
  Hence a second step — and the cost in it is named by the same address that
  sits in the group chat, not by the words "related data".
-->
{#if asking && held}
  {@const going = held}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="release-slug-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card w-full max-w-[440px] border border-line bg-canvas p-5 shadow-pop">
      <h2 id="release-slug-title" class="text-title font-semibold text-ink">
        {tr('admin.publication.releaseHeading', { address: going.slug })}
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        {tr("admin.it.currently.leads.to.the.page")}
        {#if going.holder.name}«{going.holder.name}»{/if}{tr("admin.after.transfer.this.link.will.open.the.current.publication.instea")}
      </p>
      {#if error}
        <p class="mt-3 text-ui text-danger">{error}</p>
      {/if}
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn-outline" disabled={busy} onclick={() => (asking = false)}>
          {tr("admin.cancel")}
        </button>
        <button
          type="button"
          class="btn bg-danger text-white hover:brightness-110 disabled:opacity-40"
          disabled={busy}
          onclick={() => void release()}
        >
          {busy ? tr("admin.transferring") : tr("admin.transfer.address")}
        </button>
      </div>
    </div>
  </div>
{/if}

<!--
  Releasing your own former name — the same question, but nobody is waiting
  for the name.

  Here it is released not in order to take it: it is freed for everyone, and
  the only thing that will happen for sure is that the link with it stops
  opening. Hence different words, and a different verb on the button.
-->
{#if dropping}
  {@const going = dropping}
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="drop-slug-title"
    class="dialog-veil fixed inset-0 z-50 flex items-center justify-center bg-brand/40 p-6"
  >
    <div class="dialog-card w-full max-w-[440px] border border-line bg-canvas p-5 shadow-pop">
      <h2 id="drop-slug-title" class="text-title font-semibold text-ink">
        {tr('admin.publication.releaseHeading', { address: going })}
      </h2>
      <p class="mt-2 text-ui leading-relaxed text-muted">
        {tr("admin.this.link.will.stop.opening.the.current.publication.another.publi")}
      </p>
      {#if error}
        <p class="mt-3 text-ui text-danger">{error}</p>
      {/if}
      <div class="mt-5 flex justify-end gap-2">
        <button type="button" class="btn-outline" disabled={busy} onclick={() => (dropping = null)}>
          {tr("admin.cancel")}
        </button>
        <button
          type="button"
          class="btn bg-danger text-white hover:brightness-110 disabled:opacity-40"
          disabled={busy}
          onclick={() => void dropFormer()}
        >
          {busy ? tr("admin.releasing") : tr("admin.release.address")}
        </button>
      </div>
    </div>
  </div>
{/if}
