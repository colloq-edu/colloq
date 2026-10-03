<script lang="ts">
  /**
   * What this seminar will take, on the machine's own scale.
   *
   * The room's memory and the class's personal-notebook container are two
   * limits in two places of the form; the question a teacher actually asks is
   * one — "will it fit next to what is already running?" — so it is answered
   * once, under both, against everything the machine has already promised:
   * other rooms, other classes' notebooks and the competition queue at full
   * load (the Resources tab's budget).
   */
  import { formatNumber, tr } from '@shared/i18n'
  import type { ResourceBudget } from '@shared/admin'
  import { cn } from '@/lib/utils'

  interface Props {
    roomMemoryMb: number
    roomCpus: number
    /** 0 when students have no personal notebooks. */
    ownMemoryMb: number
    ownCpus: number
    /** What the machine has promised already; null — not known, the bar is left out. */
    budget: ResourceBudget | null
  }

  let { roomMemoryMb, roomCpus, ownMemoryMb, ownCpus, budget }: Props = $props()

  const gb = (mb: number): string => formatNumber(mb / 1024, { maximumFractionDigits: 1 })

  const takes = $derived({ memoryMb: roomMemoryMb + ownMemoryMb, cpus: roomCpus + ownCpus })

  const machine = $derived.by(() => {
    if (!budget) return null
    const others = budget.rooms.memoryMb + budget.own.memoryMb + (budget.competitions.memoryMb ?? 0)
    const usable = budget.totalMb - budget.reserveMb
    const left = usable - others - takes.memoryMb
    const scale = Math.max(budget.totalMb, others + takes.memoryMb + budget.reserveMb)
    return { others, left, scale, totalMb: budget.totalMb, totalCpus: budget.totalCpus }
  })

  const width = (mb: number, scale: number): string => `${Math.max(0, (mb / Math.max(scale, 1)) * 100)}%`
</script>

<div class="flex flex-col gap-2.5 border-t border-line-soft pt-5">
  <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
    <div class="flex flex-wrap items-baseline gap-x-2.5">
      <!-- The Resources tab's gauge voice («ПАМЯТЬ 28 из 72 ГБ»): a stacked
           section title, then the figure. Black weight was the workspace's. -->
      <span class="admin-section-title">{tr('admin.footprint.title')}</span>
      <span class="text-head font-bold text-ink">
        {tr('admin.footprint.takes', { memory: gb(takes.memoryMb), count: takes.cpus })}
      </span>
    </div>
    {#if machine}
      <span class={cn('text-ui font-semibold', machine.left < 0 ? 'text-danger' : 'text-positive')}>
        {machine.left < 0
          ? tr('admin.footprint.short', { memory: gb(-machine.left) })
          : tr('admin.footprint.left', { memory: gb(machine.left) })}
      </span>
    {/if}
  </div>
  {#if machine}
    <div class="flex h-3.5 gap-0.5" aria-hidden="true">
      <span class="bg-primary" style:width={width(roomMemoryMb, machine.scale)}></span>
      {#if ownMemoryMb > 0}<span class="bg-brand-2" style:width={width(ownMemoryMb, machine.scale)}></span>{/if}
      <span class="bg-faint/35" style:width={width(machine.others, machine.scale)}></span>
      <span class="flex-1 border border-dashed border-line bg-surface"></span>
    </div>
    <div class="admin-meta flex flex-wrap items-center gap-x-5 gap-y-1.5">
      <span class="flex items-center gap-1.5">
        <span class="size-2 shrink-0 bg-primary"></span>{tr('admin.footprint.room', { memory: gb(roomMemoryMb) })}
      </span>
      {#if ownMemoryMb > 0}
        <span class="flex items-center gap-1.5">
          <span class="size-2 shrink-0 bg-brand-2"></span>{tr('admin.footprint.own', { memory: gb(ownMemoryMb) })}
        </span>
      {/if}
      <span class="flex items-center gap-1.5">
        <span class="size-2 shrink-0 bg-faint/35"></span>{tr('admin.footprint.others', { memory: gb(machine.others) })}
      </span>
      <span class="ml-auto font-mono">
        {tr('admin.footprint.machine', { memory: gb(machine.totalMb), count: machine.totalCpus })}
      </span>
    </div>
    {#if machine.left < 0}
      <p class="text-2xs text-danger">{tr('admin.footprint.shortNote')}</p>
    {/if}
  {/if}
</div>
