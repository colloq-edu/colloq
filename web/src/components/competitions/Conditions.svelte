<script lang="ts">
  /**
   * "CHECK CONDITIONS" — the right column of P2.
   *
   * Six pairs, and each answers a question that would otherwise be asked of
   * the teacher in the course chat: how much time, how much memory, is there
   * internet, where the data is, what to call the predictions file. The
   * numbers are the same ones the container is started with
   * (`competition.limits`), not copied into the mockup by hand.
   */
  import { tr } from '@shared/i18n'
  import type { CompetitionPublic } from '@shared/competitions'
  import type { EntrantSealedFile } from '@shared/competitions-entrant'
  import EnvironmentLink from '@/components/ui/EnvironmentLink.svelte'
  import { rowsWords, sealedTarget } from '@/lib/competition-words'

  interface Props {
    competition: CompetitionPublic
    /** The hidden test, as names and rows: each gets a row of its own, and the note explains it. */
    sealedFiles?: EntrantSealedFile[]
  }

  const { competition, sealedFiles = [] }: Props = $props()

  /*
   * With a hidden test the column answers two more questions before they are
   * asked (C1, C3): which file is swapped and how big it is, and what a
   * failure on it will show. `brief` is the default policy: absent means it.
   */
  const brief = $derived((competition.outputPolicy ?? 'brief') !== 'full')
  const target = $derived(sealedTarget({ files: [], sealedFiles }))
  const sealedRows = $derived([
    ...sealedFiles.map((file) => ({
      label: `data/${file.name}`,
      value: file.rows === null ? tr('competitions.p.condSealedBare') : tr('competitions.p.condSealed', { rows: rowsWords(file.rows) }),
      sealed: true,
    })),
    ...(sealedFiles.length > 0
      ? [
          {
            label: tr('competitions.p.condOutput'),
            value: tr(brief ? 'competitions.p.condOutputBrief' : 'competitions.p.condOutputFull'),
          },
        ]
      : []),
  ])
  /*
   * The note under the column: with a hidden test it says where the test goes
   * and, under the brief policy, why a failure shows only a cell and a type.
   */
  const note = $derived(
    target
      ? [
          tr(target.replaces ? 'competitions.p.conditionsSealedSwap' : 'competitions.p.conditionsSealedAdd', {
            file: target.file,
          }),
          brief ? tr('competitions.p.conditionsSealedBrief') : '',
        ]
          .filter(Boolean)
          .join(' ')
      : tr('competitions.p.conditionsNote'),
  )

  const rows: { label: string; value: string; environment?: boolean; sealed?: boolean }[] = $derived([
    {
      label: tr('competitions.p.condTime'),
      value: tr('competitions.p.condTimeValue', {
        count: Math.max(1, Math.round(competition.limits.wallSeconds / 60)),
      }),
    },
    {
      label: tr('competitions.p.condMachine'),
      value: tr('competitions.p.condMachineValue', {
        memory: tr('competitions.p.gigabytes', {
          count: Math.round((competition.limits.memoryMb / 1024) * 10) / 10,
        }),
        cores: tr('competitions.p.cores', { count: competition.limits.cpus }),
      }),
    },
    { label: tr('competitions.p.condInternet'), value: tr('competitions.p.condNo') },
    { label: tr('competitions.p.condEnvironment'), value: competition.environment, environment: true },
    { label: tr('competitions.p.condData'), value: tr('competitions.p.condDataValue') },
    ...sealedRows,
    { label: tr('competitions.p.condAnswer'), value: 'submission.csv' },
    // Only a score spends one (since 4 Oct 2026), and the value says so.
    ...(competition.limits.perDay > 0
      ? [{ label: tr('competitions.p.condPerDay'), value: tr('competitions.p.condPerDayValue', { count: competition.limits.perDay }) }]
      : []),
  ])
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-micro font-black uppercase leading-5 tracking-label text-muted">
    {tr('competitions.p.conditions')}
  </h2>
  <dl class="flex flex-col border-t border-line">
    {#each rows as row (row.label)}
      <div class="flex justify-between gap-3 border-b border-line py-[9px]">
        <dt class="min-w-0 truncate text-2xs leading-4 text-muted">{row.label}</dt>
        <dd
          class="min-w-0 truncate text-right font-mono text-micro leading-4 {row.sealed
            ? 'font-bold text-brand-2 dark:text-accent'
            : 'text-ink'}"
        >
          {#if row.environment}
            <EnvironmentLink name={competition.environment} endpoint={`/api/k/competitions/${encodeURIComponent(competition.slug)}/environment`} />
          {:else}
            {row.value}
          {/if}
        </dd>
      </div>
    {/each}
  </dl>
  <p class="text-ui leading-5 text-muted">{note}</p>
  <!-- Every writable folder of a submission is memory, and so is the room its
       package set is installed into: the memory above is for all of it. -->
  <p class="text-ui leading-5 text-muted">{tr('competitions.p.conditionsMemoryNote')}</p>
</section>
