<!--
  Картинка из папки семинара.

  Отдельный компонент ради одной строки, которой не хватало: у файла в комнате
  нет открытого адреса. Всё, что лежит в папке, отдаётся либо по заголовку с
  токеном участника, либо по одноразовому билету в строке запроса, — и `<img>`
  не умеет ни того ни другого сам. Тег с прямым адресом получал 401 и рисовал
  то, что рисует всякий сломанный `<img>`: имя файла из `alt`. Выглядело это как
  «картинки не открываются», и это была правда.

  Билет берётся тем же путём, что и у скачивания: токен уходит заголовком,
  обратно приходит право на ОДИН файл на пять минут, и уже оно едет в адресе.
-->
<script lang="ts">
  import { api } from '@/lib/api'
  import { getSessionState } from '@/lib/session.svelte'
  import { baseOf } from '@shared/paths'

  interface Props {
    path: string
  }

  let { path }: Props = $props()

  const session = getSessionState()

  let src = $state<string | null>(null)
  let failed = $state<string | null>(null)

  $effect(() => {
    const wanted = path
    let alive = true
    src = null
    failed = null
    void api
      .fileTicket(session.session.id, wanted, session.token)
      .then(({ token }) => {
        if (!alive) return
        src = api.fileUrl(session.session.id, wanted, token)
      })
      .catch((err: unknown) => {
        if (!alive) return
        failed = err instanceof Error ? err.message : 'Не удалось открыть изображение.'
      })
    return () => {
      alive = false
    }
  })
</script>

<div class="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface p-6">
  {#if failed}
    <p class="max-w-sm text-center text-ui text-muted">{failed}</p>
  {:else if src}
    <!--
      `object-contain` и оба потолка: снимок экрана с ретины — это 3000 пикселей
      по ширине, и без них он растянул бы колонку и увёл бы страницу вбок.
    -->
    <img
      {src}
      alt={baseOf(path)}
      class="max-h-full max-w-full object-contain"
      onerror={() => (failed = `${baseOf(path)} не удалось открыть как изображение.`)}
    />
  {:else}
    <p class="text-ui text-muted">Загружается {baseOf(path)}…</p>
  {/if}
</div>
