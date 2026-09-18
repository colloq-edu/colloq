/* Progressive enhancement: every guide and navigation link also works without JavaScript. */
(() => {
  const lang = document.documentElement.lang === 'en' ? 'en' : 'ru';
  const text = {
    ru: {
      start: 'Начните вводить название или вопрос.',
      searching: 'Ищем в документации…',
      found: (count, shown) => `Найдено: ${count}${count > shown ? `. Показаны первые ${shown}.` : '.'}`,
      nothing: 'Ничего не найдено. Попробуйте «ядро», «публикация» или «backup».',
      failed: 'Не удалось загрузить поиск. Попробуйте ещё раз или выберите статью в меню разделов.',
      copy: 'Копировать', copyLabel: 'Копировать этот блок кода', copied: 'Скопировано', copyByHand: 'Выделите код вручную',
    },
    en: {
      start: 'Start typing a title or a question.',
      searching: 'Searching the docs…',
      found: (count, shown) => `Found: ${count}${count > shown ? `. Showing the first ${shown}.` : '.'}`,
      nothing: 'Nothing found. Try “kernel”, “publishing” or “backup”.',
      failed: 'Search could not load. Try again or pick an article from the menu.',
      copy: 'Copy', copyLabel: 'Copy this code block', copied: 'Copied', copyByHand: 'Select the code by hand',
    },
  }[lang];

  // Language switch: the other language's link keeps the #section, and the choice is
  // remembered. No page redirects on its own (URLs stay stable); a remembered choice
  // that differs from this page only highlights the switch.
  const LANG_KEY = 'colloq-docs-lang';
  const switchLinks = [...document.querySelectorAll('.lang-switch a[data-lang]')];
  switchLinks.forEach(link => { link.dataset.base = link.getAttribute('href'); });
  const syncHash = () => switchLinks.forEach(link => link.setAttribute('href', link.dataset.base + location.hash));
  syncHash();
  window.addEventListener('hashchange', syncHash);
  switchLinks.forEach(link => link.addEventListener('click', () => {
    syncHash();
    try { localStorage.setItem(LANG_KEY, link.dataset.lang); } catch {}
  }));
  let preferred = null;
  try { preferred = localStorage.getItem(LANG_KEY); } catch {}
  if (preferred && preferred !== lang) switchLinks.find(link => link.dataset.lang === preferred)?.classList.add('lang-suggested');

  const menu = document.querySelector('.mobile-nav');
  const mobile = window.matchMedia('(max-width: 760px)');
  const syncMenu = () => { menu.open = !mobile.matches; };
  syncMenu();
  mobile.addEventListener('change', syncMenu);

  const dialog = document.querySelector('#search-dialog');
  const trigger = document.querySelector('.search-trigger');
  const input = document.querySelector('#search-input');
  const results = document.querySelector('#search-results');
  const status = document.querySelector('#search-status');
  let entries = null;
  let loading = null;
  let returnFocus = null;
  const normalize = value => value.toLocaleLowerCase(lang).replaceAll('ё', 'е');

  async function loadIndex() {
    if (entries) return entries;
    if (!loading) {
      // Each language has its own index next to its pages: /docs/ and /docs/en/.
      loading = fetch(new URL('search-index.json', location.href))
        .then(response => { if (!response.ok) throw new Error('index'); return response.json(); })
        .then(data => { entries = data.map(entry => ({ ...entry, haystack: normalize(entry.title + ' ' + entry.section + ' ' + entry.text) })); return entries; })
        .catch(error => { loading = null; throw error; });
    }
    return loading;
  }

  async function search() {
    const query = normalize(input.value.trim());
    results.replaceChildren();
    if (!query) { status.textContent = text.start; return; }
    status.textContent = text.searching;
    try {
      const all = await loadIndex();
      if (query !== normalize(input.value.trim())) return;
      const words = query.split(/\s+/).filter(Boolean);
      const matches = all.filter(entry => words.every(word => entry.haystack.includes(word)))
        .map(entry => ({ entry, score: words.reduce((sum, word) => sum + (normalize(entry.title).includes(word) ? 5 : 0) + (normalize(entry.section).includes(word) ? 2 : 0), 0) }))
        .sort((a, b) => b.score - a.score);
      const shown = matches.slice(0, 18);
      status.textContent = matches.length ? text.found(matches.length, shown.length) : text.nothing;
      for (const { entry } of shown) {
        const link = document.createElement('a');
        link.className = 'search-result';
        link.href = entry.url;
        const label = document.createElement('small');
        label.textContent = entry.section;
        const title = document.createElement('strong');
        title.textContent = entry.title;
        const snippet = document.createElement('p');
        const first = normalize(entry.text).indexOf(words[0]);
        const start = Math.max(0, first - 55);
        snippet.textContent = (start ? '…' : '') + entry.text.slice(start, start + 190) + (entry.text.length > start + 190 ? '…' : '');
        link.append(label, title, snippet);
        link.addEventListener('click', () => dialog.close());
        results.append(link);
      }
    } catch {
      if (query === normalize(input.value.trim())) status.textContent = text.failed;
    }
  }
  if (typeof dialog.showModal === 'function') {
    trigger.hidden = false;
    const open = () => {
      if (dialog.open) return;
      returnFocus = document.activeElement;
      dialog.showModal();
      document.body.classList.add('search-open');
      input.focus();
      void search();
    };
    trigger.addEventListener('click', open);
    document.querySelector('.close-search').addEventListener('click', () => dialog.close());
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); dialog.close(); } });
    dialog.addEventListener('close', () => { document.body.classList.remove('search-open'); returnFocus?.focus(); });
    dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
    document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); open(); } });
    input.addEventListener('input', () => void search());
    input.addEventListener('keydown', event => { if (event.key === 'ArrowDown') { const first = results.querySelector('a'); if (first) { event.preventDefault(); first.focus(); } } });
  }

  if (navigator.clipboard?.writeText) {
    document.querySelectorAll('pre').forEach(pre => {
      const code = pre.querySelector('code');
      if (!code) return;
      const button = document.createElement('button');
      button.className = 'copy-code';
      button.type = 'button';
      button.textContent = text.copy;
      button.setAttribute('aria-label', text.copyLabel);
      button.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(code.textContent); button.textContent = text.copied; }
        catch { button.textContent = text.copyByHand; }
        setTimeout(() => { button.textContent = text.copy; }, 2200);
      });
      pre.append(button);
    });
  }

  if ('IntersectionObserver' in window) {
    const links = [...document.querySelectorAll('.toc a')];
    const observer = new IntersectionObserver(items => {
      const visible = items.filter(item => item.isIntersecting);
      if (!visible.length) return;
      const id = visible[0].target.id;
      links.forEach(link => { if (link.hash === '#' + id) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current'); });
    }, { rootMargin: '-90px 0px -65% 0px' });
    document.querySelectorAll('.article-body h2[id]').forEach(heading => observer.observe(heading));
  }
})();
