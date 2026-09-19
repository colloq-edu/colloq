<script lang="ts">
  import Splash from '@/components/ui/Splash.svelte'
  import { firstScreenReady } from '@/lib/boot'
  import { onMount } from 'svelte'
  import AdminShell, { type AdminTab } from '@/admin/AdminShell.svelte'
  import NewSeminar from '@/admin/screens/NewSeminar.svelte'
  import { adminAuth } from '@/admin/auth.svelte'
  import Oracle from '@/admin/screens/Oracle.svelte'
  import Environments from '@/admin/screens/Environments.svelte'
  import Seminars from '@/admin/screens/Seminars.svelte'
  import Courses from '@/admin/screens/Courses.svelte'
  import Publish from '@/admin/screens/Publish.svelte'
  import Teachers from '@/admin/screens/Teachers.svelte'
  import SignInScreen from '@/screens/SignInScreen.svelte'
  import { readEntryCredential, SPENT_PATH } from '@/admin/entry'

  /**
   * Sub-routing for /admin. It keeps its own copy of the path rather than
   * taking one from App, because the key exchange below has to rewrite the URL
   * with replaceState — which fires no popstate for anyone else to hear.
   */
  let path = $state(location.pathname)

  /*
   * Not a route. Creating is a step inside the seminars tab rather than a place
   * you can be sent to: a half-filled form behind a URL is a form somebody
   * returns to expecting their answers to still be there.
   */
  let makingSeminar = $state(false)
  /** The seminar just made on the New seminar screen, handed to the list. */
  let arrived = $state<string | null>(null)

  /*
   * Обмен идёт прямо сейчас.
   *
   * Состояние, а не «в адресе ещё ключ»: не доехавший ключ намеренно не
   * тратится (ниже), адрес остаётся прежним — и экран, ждавший исчезновения
   * ключа из адреса, оставался пустым навсегда. Пустая страница без слов —
   * ровно то, ради чего у экрана входа есть ветка «Could not reach the panel».
   */
  let exchanging = $state(readEntryCredential(location.pathname) !== null)
  /**
   * Ключ, который не доехал.
   *
   * Сервер его не видел, поэтому он цел и всё ещё в адресе. «Try again» на
   * экране входа перечитывает состояние инстанса — и, если сервер вернулся,
   * попытку надо повторить: иначе преподавателя с рабочей ссылкой встречает
   * форма, просящая токен установки, которого у него нет.
   */
  let pendingKey = $state<string | null>(null)
  /**
   * Токен установки, который не доехал, — по тому же поводу и с тем же правом.
   *
   * Ключ научили не тратиться на обрыве связи, а токен продолжал тратиться
   * безусловно: `.finally(spend)`. Разницы для человека никакой — обе ссылки
   * одноразовые на вид и обе исчезают из адресной строки, — а токен вдобавок
   * подставляется в форму первого запуска только при явном `unclaimed`. То
   * есть после «Try again» преподаватель с рабочей ссылкой получал пустое поле
   * и тридцать два символа, которые надо было откуда-то переписать.
   */
  let pendingToken = $state<string | null>(null)
  let retriedEntry = false
  const tab = $derived<AdminTab>(
    path.startsWith('/admin/oracle')
      ? 'oracle'
      : path.startsWith('/admin/teachers')
        ? 'teachers'
        : path.startsWith('/admin/environments')
          ? 'environments'
          : path.startsWith('/admin/courses')
            ? 'courses'
            : 'seminars',
  )

  /*
   * Открытый курс — в адресе, в отличие от формы создания семинара: сюда
   * возвращаются, этой ссылкой делятся с коллегой, и «назад» обязана уводить в
   * список курсов, а не из панели.
   */
  const openCourse = $derived(/^\/admin\/courses\/([A-Za-z0-9_-]{1,64})/.exec(path)?.[1] ?? null)
  /* Публикация — тоже адрес: это экран, на котором принимают решение. */
  const publishing = $derived(/^\/admin\/publish\/([A-Za-z0-9_-]{1,64})/.exec(path)?.[1] ?? null)

  // replaceState, never push: a spent credential must not sit in the address
  // bar, and must not be one Back press away either.
  function spend(): void {
    history.replaceState({}, '', SPENT_PATH)
    path = SPENT_PATH
  }

  /*
   * Ключ тратится, только если сервер его увидел.
   *
   * Раньше здесь стоял безусловный `.finally(spend)`: адресная строка
   * переписывалась и при обычном обрыве связи — вайфай моргнул, поезд въехал в
   * туннель, — и ссылка, которая была единственной дорогой в панель, исчезала
   * навсегда за один неудачный запрос. Отозванный ключ тратить правильно (он
   * всё равно мёртв), а не доехавший — нет.
   */
  async function useKey(key: string): Promise<void> {
    exchanging = true
    pendingKey = null
    try {
      const signedIn = await adminAuth.signInWithKey(key)
      if (signedIn || adminAuth.state) spend()
      // Сервера не было слышно вовсе: ключ цел, и попробовать его стоит ещё раз.
      else pendingKey = key
    } finally {
      exchanging = false
    }
  }

  /**
   * Токен установки — по правилу ключа выше.
   *
   * `adminAuth.state` здесь и есть «сервер ответил»: `#authenticate` дочитывает
   * состояние инстанса даже на отказе (см. auth.svelte.ts), так что пусто оно
   * ровно тогда, когда сервера не было слышно вовсе.
   */
  async function useToken(setupToken: string): Promise<void> {
    exchanging = true
    pendingToken = null
    try {
      const signedIn = await adminAuth.signInWithToken(setupToken)
      if (signedIn) {
        spend()
        return
      }
      // 409 here means "not claimed yet", which is exactly the state the card
      // below is for. Leaving it as an error would tell a person following the
      // printed link that they did something wrong.
      //
      // Всё остальное — отозванный токен, опечатка в ссылке — надо сказать
      // словами. Раньше гасилась любая ошибка, и мёртвый токен молча
      // подставлялся в форму, где выяснялся только после нажатия «Sign in».
      const unclaimed = adminAuth.errorReason === 'unclaimed'
      const said = adminAuth.error
      const reason = adminAuth.errorReason

      // The reload is not optional: the sign-in screen draws nothing until it
      // knows whether the instance is claimed, and a failed exchange leaves
      // that unknown. Without this the first-run link opened an empty page —
      // measured, not guessed.
      await adminAuth.refresh()

      if (unclaimed) {
        // A token cannot sign anyone in until the instance has an owner, and
        // claiming needs a name and an email this link does not carry. So the
        // token is carried into the form rather than spent on a request that
        // was always going to fail — the person types two fields instead of
        // also transcribing thirty-two characters.
        adminAuth.offerSetupToken(setupToken)
      } else if (adminAuth.error === null) {
        // Успешный refresh гасит ошибку внутри себя, поэтому её возвращают
        // сюда руками. Своя жалоба у refresh новее — она и остаётся.
        adminAuth.error = said
        adminAuth.errorReason = reason
      }

      // Сервера не было слышно вовсе: токен цел и адрес не тратим.
      if (!adminAuth.state) {
        pendingToken = setupToken
        return
      }
      spend()
    } finally {
      exchanging = false
    }
  }

  $effect(() => {
    const reachable = adminAuth.state !== null
    const signedIn = adminAuth.me !== null
    if (retriedEntry || exchanging || !reachable || signedIn) return
    // Один раз: вторая неудача — это уже не «сервер не поднялся», и крутить
    // запросы под экраном с кнопкой «Try again» незачем.
    if (pendingKey) {
      retriedEntry = true
      void useKey(pendingKey)
      return
    }
    if (pendingToken) {
      retriedEntry = true
      void useToken(pendingToken)
    }
  })

  /*
   * Панели есть что показать, когда она знает, что показывать: состояние
   * инстанса приехало и ключ из адреса обменян. До этого мгновения на экране
   * стоит заставка из index.html, и снимать её раньше значит открыть под ней
   * пустоту (lib/boot.ts).
   */
  $effect(() => {
    if (adminAuth.ready && !exchanging) firstScreenReady()
  })

  onMount(() => {
    const onPop = () => {
      path = location.pathname
      makingSeminar = false
    }
    window.addEventListener('popstate', onPop)

    const credential = readEntryCredential(location.pathname)
    if (credential?.kind === 'key') {
      void useKey(credential.value)
    } else if (credential?.kind === 'token') {
      void useToken(credential.value)
    } else {
      void adminAuth.load()
    }

    return () => window.removeEventListener('popstate', onPop)
  })

  function navigate(next: string): void {
    if (next !== location.pathname) history.pushState({}, '', next)
    path = next
    /*
     * Любой переход — это уход из формы «Новое занятие».
     *
     * Форма не маршрут (см. `makingSeminar`), и переход на тот же `/admin` —
     * с логотипа или со строки «Занятия» — адреса не меняет. Без этой строки
     * щелчок по ним на открытой форме не делал ничего, а уход на «Курсы» и
     * обратно возвращал в ту же форму: флаг переживал смену вкладки.
     */
    makingSeminar = false
  }
</script>

{#if !adminAuth.ready || exchanging}
  <!--
    Заставка, а не скелет панели: до ответа сервера неизвестно даже, что здесь
    будет — панель или форма входа, — а скелет рисовал шапку и строки той,
    которой может не оказаться. Та же заставка, что в index.html, и в тех же
    координатах: оболочка уходит ровно на неё (lib/boot.ts).
  -->
  <Splash />
{:else if !adminAuth.me}
  <SignInScreen />
{:else}
  <AdminShell {tab} {navigate}>
    {#if publishing}
      <Publish sessionId={publishing} {navigate} />
    {:else if tab === 'courses'}
      <Courses open={openCourse} {navigate} />
    {:else if tab === 'environments'}
      <Environments />
    {:else if tab === 'oracle'}
      <Oracle />
    {:else if tab === 'teachers'}
      <Teachers />
    {:else if makingSeminar}
      <NewSeminar
          ondone={(createdId) => {
            makingSeminar = false
            /*
             * Back to the list with the link, not into the room.
             *
             * Walking straight in feels like the finish, and it is how a class
             * starts late: the address is what the teacher needs in that second,
             * and finding it means leaving the room they were just dropped into.
             * The list puts the new seminar on top with the cursor on its Copy.
             */
            arrived = createdId ?? null
          }}
        />
    {:else}
      <!-- Приземление одноразовое: `arrived`, оставшийся висеть, снова сбрасывал
           поиск и подсвечивал ту же комнату как новую при каждом возврате на
           вкладку — и каждые двадцать секунд отбирал фокус в её пользу. -->
      <Seminars
        onfull={() => (makingSeminar = true)}
        {arrived}
        onarrived={() => (arrived = null)}
        onpublish={(id) => navigate(`/admin/publish/${id}`)}
      />
    {/if}
  </AdminShell>
{/if}
