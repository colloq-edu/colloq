/* Progressive enhancement: every guide and navigation link also works without JavaScript. */
(() => {
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
  const normalize = value => value.toLocaleLowerCase('ru').replaceAll('ё', 'е');

  async function loadIndex() {
    if (entries) return entries;
    if (!loading) {
      loading = fetch(new URL('search-index.json', document.currentScript?.src || location.href))
        .then(response => { if (!response.ok) throw new Error('index'); return response.json(); })
        .then(data => { entries = data.map(entry => ({ ...entry, haystack: normalize(entry.title + ' ' + entry.section + ' ' + entry.text) })); return entries; })
        .catch(error => { loading = null; throw error; });
    }
    return loading;
  }

  async function search() {
    const query = normalize(input.value.trim());
    results.replaceChildren();
    if (!query) { status.textContent = 'Начните вводить название или вопрос.'; return; }
    status.textContent = 'Ищем в документации…';
    try {
      const all = await loadIndex();
      if (query !== normalize(input.value.trim())) return;
      const words = query.split(/\s+/).filter(Boolean);
      const matches = all.filter(entry => words.every(word => entry.haystack.includes(word)))
        .map(entry => ({ entry, score: words.reduce((sum, word) => sum + (normalize(entry.title).includes(word) ? 5 : 0) + (normalize(entry.section).includes(word) ? 2 : 0), 0) }))
        .sort((a, b) => b.score - a.score);
      const shown = matches.slice(0, 18);
      status.textContent = matches.length ? `Найдено: ${matches.length}${matches.length > shown.length ? '. Показаны первые 18.' : '.'}` : 'Ничего не найдено. Попробуйте «ядро», «публикация» или «backup».';
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
      if (query === normalize(input.value.trim())) status.textContent = 'Не удалось загрузить поиск. Попробуйте ещё раз или выберите статью в меню разделов.';
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
      button.textContent = 'Копировать';
      button.setAttribute('aria-label', 'Копировать этот блок кода');
      button.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(code.textContent); button.textContent = 'Скопировано'; }
        catch { button.textContent = 'Выделите код вручную'; }
        setTimeout(() => { button.textContent = 'Копировать'; }, 2200);
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
