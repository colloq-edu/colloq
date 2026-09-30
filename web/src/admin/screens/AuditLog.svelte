<script lang="ts">
  import { formatDate, formatNumber, tr } from '@shared/i18n'
  /**
   * The staff audit log: who did what in the panel, newest first.
   *
   * Owners only — the server refuses everyone else, and the rail does not draw
   * the row for a teacher. A teacher who types the address anyway reads the
   * server's refusal, which says what is refused.
   *
   * A list, not a dashboard: an owner comes here with one question from a
   * data-protection officer ("who deleted that room", "when was the key
   * replaced") and reads down until the answer. So the page asks for fifty
   * events at a time and keeps what it has when more arrive; the cursor is the
   * last id, so an event recorded while the owner reads does not shift the
   * next page by one.
   *
   * The words come from `admin/audit.ts`; this file only lays them out.
   */
  import { onMount } from 'svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import { auditActionLabel, auditDetail, auditTarget } from '@/admin/audit'
  import AdminPage from '@/admin/ui/AdminPage.svelte'
  import { AdminApiError, adminApi } from '@/lib/adminApi'
  import type { AdminAuditEvent } from '@shared/admin'

  const PAGE = 50

  let events = $state<AdminAuditEvent[]>([])
  let next = $state<number | null>(null)
  let retentionDays = $state<number | null>(null)
  let loading = $state(true)
  let more = $state(false)
  let errorText = $state<(() => string) | null>(null)
  const error = $derived(errorText?.() ?? null)

  function report(cause: unknown): string {
    if (cause instanceof AdminApiError || cause instanceof Error) return cause.message
    return tr('admin.audit.loadFailed')
  }

  async function load(before: number | null = null): Promise<void> {
    if (before === null) loading = true
    else more = true
    try {
      const page = await adminApi.auditLog(before, PAGE)
      // Appended, not replaced: the rows already read stay where the eye left them.
      events = before === null ? page.events : [...events, ...page.events]
      next = page.next
      retentionDays = page.retentionDays
      errorText = null
    } catch (cause: unknown) {
      if (cause instanceof AdminApiError && cause.reason === 'unauthenticated') void adminAuth.refresh('revoked')
      errorText = () => report(cause)
    } finally {
      loading = false
      more = false
    }
  }

  onMount(() => {
    void load()
  })

  /** Date and time to the minute, in the panel's language: "30 сент. 2026 г., 17:05". */
  function when(at: number): string {
    return formatDate(at, { dateStyle: 'medium', timeStyle: 'short' })
  }

  /* The lanes, declared once so the header and every row cannot drift apart. */
  const PHONE_LANE = 'max-[640px]:w-full max-[640px]:min-w-0 max-[640px]:pr-0'
  const COL_WHEN = `w-[150px] shrink-0 pr-4 ${PHONE_LANE}`
  const COL_WHO = `w-[200px] min-w-[140px] pr-4 ${PHONE_LANE}`
  const COL_WHAT = `min-w-[220px] flex-1 pr-4 ${PHONE_LANE}`
  const COL_FROM = `w-[130px] shrink-0 ${PHONE_LANE}`
</script>

{#snippet eyebrow(text: string)}
  <span class="block text-micro font-bold uppercase tracking-label text-muted">{text}</span>
{/snippet}

<AdminPage
  title={tr('admin.audit.title')}
  subtitle={retentionDays === null
    ? tr('admin.audit.subtitleShort')
    : tr('admin.audit.subtitle', { count: retentionDays, days: formatNumber(retentionDays) })}
>
  {#if loading}
    <div class="h-24"></div>
  {:else if error && events.length === 0}
    <div class="flex items-center gap-3 py-6">
      <p class="text-ui text-danger">{error}</p>
      <button type="button" class="btn-outline" onclick={() => void load()}>{tr('admin.try.again')}</button>
    </div>
  {:else if events.length === 0}
    <p class="py-6 text-ui text-muted">{tr('admin.audit.empty')}</p>
  {:else}
    <div class="min-w-[640px] max-[640px]:min-w-0">
      <div class="sticky top-0 z-10 flex h-9 items-center border-b border-line bg-canvas max-[640px]:hidden">
        <div class={COL_WHEN}>{@render eyebrow(tr('admin.audit.when'))}</div>
        <div class={COL_WHO}>{@render eyebrow(tr('admin.audit.who'))}</div>
        <div class={COL_WHAT}>{@render eyebrow(tr('admin.audit.what'))}</div>
        <div class={COL_FROM}>{@render eyebrow(tr('admin.audit.address'))}</div>
      </div>

      {#each events as event (event.id)}
        {@const detail = auditDetail(event)}
        {@const target = auditTarget(event)}
        <div
          class="flex items-start border-b border-line-soft py-3 max-[640px]:flex-wrap max-[640px]:gap-y-1.5"
        >
          <div class="{COL_WHEN} font-mono text-2xs text-muted">{when(event.at)}</div>
          <div class={COL_WHO}>
            {#if event.actor}
              <p class="truncate text-ui font-semibold text-ink">{event.actor.name}</p>
              <p class="truncate font-mono text-2xs text-muted">{event.actor.email}</p>
            {:else}
              <p class="text-ui text-muted">—</p>
            {/if}
          </div>
          <div class={COL_WHAT}>
            <p class="text-ui text-ink">
              <span class="font-semibold">{auditActionLabel(event.action)}</span>
              {#if target}
                <!-- The id rides in the title: a room's name can repeat, its id cannot. -->
                <span class="text-muted" title={event.target?.id ?? undefined}>· {target}</span>
              {/if}
            </p>
            {#if detail}
              <p class="mt-0.5 whitespace-pre-line break-words font-mono text-2xs text-muted">{detail}</p>
            {/if}
          </div>
          <div class="{COL_FROM} break-all font-mono text-2xs text-muted">{event.ip ?? '—'}</div>
        </div>
      {/each}
    </div>

    {#if error}
      <p class="mt-3 text-ui text-danger">{error}</p>
    {/if}
    {#if next !== null}
      <div class="py-5">
        <button type="button" class="btn-outline" disabled={more} onclick={() => void load(next)}>
          {more ? tr('admin.audit.loading') : tr('admin.audit.more')}
        </button>
      </div>
    {/if}
  {/if}
</AdminPage>
