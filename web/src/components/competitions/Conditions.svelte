<script lang="ts">
  /**
   * «УСЛОВИЯ ПРОВЕРКИ» — правая колонка P2.
   *
   * Шесть пар, и каждая отвечает на вопрос, который иначе задают преподавателю
   * в чате курса: сколько времени, сколько памяти, есть ли интернет, где
   * данные, как назвать файл с прогнозами. Числа те же, с которыми запускается
   * контейнер (`competition.limits`), а не переписанные в макет от руки.
   */
  import { tr } from '@shared/i18n'
  import type { CompetitionPublic } from '@shared/competitions'
  import EnvironmentLink from '@/components/ui/EnvironmentLink.svelte'

  interface Props {
    competition: CompetitionPublic
  }

  const { competition }: Props = $props()

  const rows = $derived([
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
    { label: tr('competitions.p.condAnswer'), value: 'submission.csv' },
  ])
</script>

<section class="flex flex-col gap-3">
  <h2 class="text-micro font-black uppercase leading-5 tracking-label text-muted">
    {tr('competitions.p.conditions')}
  </h2>
  <dl class="flex flex-col border-t border-line">
    {#each rows as row (row.label)}
      <div class="flex justify-between gap-3 border-b border-line py-[9px]">
        <dt class="text-2xs leading-4 text-muted">{row.label}</dt>
        <dd class="min-w-0 truncate text-right font-mono text-micro leading-4 text-ink">
          {#if row.environment}
            <EnvironmentLink name={competition.environment} endpoint={`/api/k/competitions/${encodeURIComponent(competition.slug)}/environment`} />
          {:else}
            {row.value}
          {/if}
        </dd>
      </div>
    {/each}
  </dl>
  <p class="text-ui leading-5 text-muted">{tr('competitions.p.conditionsNote')}</p>
</section>
