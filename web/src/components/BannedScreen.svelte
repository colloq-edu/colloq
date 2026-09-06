<script lang="ts">
  /**
   * Что видит тот, кого удалили с занятия.
   *
   * Не ошибка и не авария: человека не пустили, и он должен понять — кто, до
   * какого часа и к кому идти. Молчание здесь читалось бы как сломанный
   * Colloq, а красная плашка — как поломка, в которой он не виноват; и то и
   * другое отправляет его чинить не то.
   *
   * Ничего сверх того, что делает сервер. Ни «навсегда», ни «во всех
   * браузерах»: бан живёт сутки и держится на метке, и первое же обещание,
   * которое комната не сдержит, обесценит и всё остальное на этом экране.
   *
   * Одна карточка на два места — экран входа и открытая вкладка, — а рамку
   * вокруг ставит тот, кто зовёт: на входе это страница целиком, в комнате
   * поверх неё.
   */
  import { untilWords } from '@/lib/bans'
  import Icon from '@/components/ui/Icon.svelte'

  interface Props {
    /** Момент конца бана — тот же, что назвал сервер. */
    until: number
  }

  let { until }: Props = $props()
</script>

<div class="w-full max-w-sm text-center">
  <span
    class="mx-auto flex h-10 w-10 items-center justify-center border border-line bg-surface text-faint"
  >
    <Icon name="lock" size={16} />
  </span>
  <h1 class="mt-4 text-title font-semibold tracking-tight text-ink">Вас удалили с занятия</h1>
  <p class="mt-2 text-ui leading-relaxed text-muted">
    Преподаватель закрыл вход в эту комнату до {untilWords(until)}. После этого ссылка откроется
    снова — заново называться не придётся.
  </p>
  <p class="mt-2 text-ui leading-relaxed text-muted">
    Если это недоразумение, скажите преподавателю: снять это он может сразу.
  </p>
</div>
