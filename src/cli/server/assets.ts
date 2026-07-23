// Styling and interactivity for the `serve` editor page. Ported near-verbatim
// from the standalone potman PO-editor tool this command replaces — same
// look, same filter/search/copy/fill/translate behavior. Embedded as string
// constants (not files) because `bun build --compile` ships a single binary
// with nothing alongside it on disk.

export const STYLE_CSS = `
:root {
	--bg: #f6f6f4;
	--panel: #ffffff;
	--border: #e0ded7;
	--ink: #1c1d1f;
	--muted: #6b6d72;
	--accent: #2d5ce8;
	--accent-soft: #e8edfc;
	--ok: #1a8a5f;
	--ok-soft: #e7f5ee;
	--warn: #b4780a;
	--warn-soft: #fbf1de;
	--fuzzy: #7c3fc4;
	--fuzzy-soft: #f1e9fb;
	--mono: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
	--sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
}

* {
	box-sizing: border-box;
}

body {
	margin: 0;
	background: var(--bg);
	color: var(--ink);
	font-family: var(--sans);
	font-size: 13px;
}

header {
	position: sticky;
	top: 0;
	z-index: 10;
	background: var(--panel);
	border-bottom: 1px solid var(--border);
	padding: 8px 24px;
	display: flex;
	align-items: center;
	gap: 14px;
	flex-wrap: wrap;
}

header h1 {
	font-size: 14px;
	font-weight: 700;
	margin: 0;
	letter-spacing: .2px;
}

header .filename {
	font-family: var(--mono);
	font-size: 12px;
	color: var(--muted);
}

select,
.btn {
	font-family: var(--sans);
	font-size: 12.5px;
	font-weight: 600;
	border: 1px solid var(--border);
	background: var(--panel);
	color: var(--ink);
	padding: 5px 12px;
	border-radius: 6px;
}

select {
	cursor: pointer;
}

.btn {
	cursor: pointer;
}

.btn:hover {
	border-color: #c8c5bc;
}

.btn.primary {
	background: var(--accent);
	color: #fff;
	border-color: var(--accent);
}

.btn.primary:hover {
	background: #2249c9;
}

header input[type=search] {
	width: 200px;
	padding: 5px 10px;
	border: 1px solid var(--border);
	border-radius: 6px;
	font-size: 12.5px;
	font-family: var(--sans);
}

.filter-group {
	display: flex;
	gap: 6px;
	margin-left: auto;
}

.filter-btn {
	font-size: 12px;
	font-weight: 600;
	padding: 4px 10px;
	border-radius: 5px;
	border: 1px solid var(--border);
	background: var(--bg);
	color: var(--muted);
	cursor: pointer;
}

.filter-btn.active {
	background: var(--accent-soft);
	color: var(--accent);
	border-color: var(--accent);
}

main {
	max-width: 1024px;
	margin: 0 auto;
	padding: 14px 24px 24px;
}

.banner {
	background: var(--ok-soft);
	color: var(--ok);
	border: 1px solid var(--ok);
	border-radius: 7px;
	padding: 8px 12px;
	margin-bottom: 12px;
	font-size: 12.5px;
	font-weight: 600;
}

.empty-state {
	text-align: center;
	padding: 80px 20px;
	color: var(--muted);
}

.empty-state h2 {
	color: var(--ink);
	font-size: 18px;
	margin-bottom: 6px;
}

.row {
	display: flex;
	background: var(--panel);
	border: 1px solid var(--border);
	border-radius: 8px;
	margin-bottom: 6px;
	overflow: hidden;
}

.row.is-translating {
	border-color: var(--accent);
	animation: glot-row-pulse 1.4s ease-in-out infinite;
}

@keyframes glot-row-pulse {
	0%, 100% { background: var(--panel); }
	50% { background: var(--accent-soft); }
}

.row .gutter {
	width: 3px;
	flex-shrink: 0;
}

.gutter.status-untranslated {
	background: var(--warn);
}

.gutter.status-translated {
	background: var(--ok);
}

.gutter.status-fuzzy {
	background: var(--fuzzy);
}

.row-body {
	flex: 1;
	padding: 8px 12px;
	min-width: 0;
}

.row-meta {
	flex-shrink: 0;
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	justify-content: flex-start;
	gap: 2px;
	padding: 8px 12px;
	border-left: 1px solid var(--border);
	text-align: right;
}

.row-index {
	font-family: var(--mono);
	font-size: 10.5px;
	color: var(--muted);
	cursor: pointer;
}

.row-context {
	font-size: 11px;
	color: var(--muted);
	font-family: var(--mono);
}

.row-occurrences {
	display: none;
	font-size: 10.5px;
	color: var(--muted);
	margin-top: 1px;
	word-break: break-all;
}

.row-occurrences.is-visible {
	display: block;
}

.pair {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 10px;
	align-items: start;
	margin-bottom: 5px;
}

.msgid-col {
	display: flex;
	flex-direction: column;
	gap: 3px;
	align-self: stretch;
}

.msgid {
	font-family: var(--mono);
	font-size: 12.5px;
	color: var(--ink);
	white-space: pre-wrap;
	word-break: break-word;
	margin: 0;
	padding: 5px 0px;
	border-radius: 5px;
	align-self: stretch;
}

.plural-label {
	font-size: 10.5px;
	color: var(--muted);
	margin: 0 0 2px;
	font-family: var(--mono);
}

.msgid-row,
.msgstr-row {
	display: flex;
	align-items: flex-start;
	gap: 4px;
	flex-wrap: wrap;
}

.msgid-row .msgid {
	flex: 1;
}

.msgstr-row textarea {
	flex: 1;
}

.icon-btn {
	flex-shrink: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	width: 20px;
	height: 20px;
	border: 1px solid var(--border);
	border-radius: 4px;
	background: var(--panel);
	color: var(--muted);
	cursor: pointer;
	padding: 0;
}

.icon-btn:hover {
	border-color: var(--accent);
	color: var(--accent);
	background: var(--accent-soft);
}

.icon-btn.copied {
	border-color: var(--ok);
	color: var(--ok);
	background: var(--ok-soft);
}

.icon-btn:disabled {
	cursor: wait;
	opacity: .6;
}

.translate-suggestion {
	flex-basis: 100%;
	margin-top: 4px;
	padding: 4px 8px;
	border-radius: 5px;
	border: 1px solid var(--border);
	background: var(--panel);
	color: var(--ink);
	font-family: var(--mono);
	font-size: 12px;
	white-space: pre-wrap;
	word-break: break-word;
	cursor: pointer;
}

.suggestion-tag {
	display: inline-block;
	font-family: var(--sans);
	font-size: 9.5px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: .04em;
	padding: 1px 5px;
	border-radius: 3px;
	margin-right: 6px;
	vertical-align: middle;
}

.translate-suggestion.approved .suggestion-tag {
	background: var(--ok-soft);
	color: var(--ok);
}

.translate-suggestion.ai .suggestion-tag {
	background: var(--accent-soft);
	color: var(--accent);
}

textarea {
	width: 100%;
	font-family: var(--mono);
	font-size: 12.5px;
	color: var(--ink);
	border: 1px solid var(--border);
	border-radius: 5px;
	padding: 5px 8px;
	resize: vertical;
	min-height: 30px;
	line-height: 1.4;
}

textarea:focus {
	border-color: var(--accent);
	outline: none;
}

.no-files {
	max-width: 560px;
	margin: 80px auto;
	text-align: center;
	padding: 32px;
	background: var(--panel);
	border: 1px solid var(--border);
	border-radius: 12px;
}
`;

export const SCRIPT_JS = `
const search = document.getElementById('search');
const rows = Array.from(document.querySelectorAll('.row'));
let currentFilter = 'all';

function applyFilters() {
   const term = search.value.trim().toLowerCase();
   rows.forEach(row => {
      const matchesFilter = currentFilter === 'all' || row.dataset.status === currentFilter;
      const matchesSearch = !term || row.dataset.search.includes(term);
      row.style.display = (matchesFilter && matchesSearch) ? '' : 'none';
   });
}

search.addEventListener('input', applyFilters);
document.querySelectorAll('.filter-btn').forEach(btn => {
   btn.addEventListener('click', () => {
      currentFilter = btn.dataset.filter;
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b === btn));
      applyFilters();
   });
});

document.querySelectorAll('.row-index').forEach(idx => {
   idx.addEventListener('click', () => {
      const occurrences = idx.closest('.row').querySelector('.row-occurrences');
      if (occurrences) occurrences.classList.toggle('is-visible');
   });
});

function flashCopied(btn) {
   btn.classList.add('copied');
   setTimeout(() => btn.classList.remove('copied'), 700);
}

document.querySelectorAll('[data-copy]').forEach(btn => {
   btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.dataset.copy);
      flashCopied(btn);
   });
});

document.querySelectorAll('[data-fill]').forEach(btn => {
   btn.addEventListener('click', () => {
      const text = btn.dataset.fill;
      const textarea = btn.closest('.pair').querySelector('textarea');
      textarea.value = text;
      navigator.clipboard.writeText(text);
      flashCopied(btn);
   });
});

document.querySelectorAll('.translate-suggestion[data-suggestion]').forEach(el => {
   el.addEventListener('click', () => {
      const textarea = el.closest('.pair').querySelector('textarea');
      textarea.value = el.dataset.suggestion;
   });
});

function showSuggestion(textarea, text) {
   const row = textarea.closest('.msgstr-row');
   let box = row.querySelector('.translate-suggestion.dynamic-suggestion');
   if (!box) {
      box = document.createElement('div');
      box.classList.add('translate-suggestion', 'ai', 'dynamic-suggestion');
      box.title = 'Click to use this translation';
      row.appendChild(box);
   }
   box.textContent = '';
   const tag = document.createElement('span');
   tag.className = 'suggestion-tag';
   tag.textContent = 'AI';
   box.appendChild(tag);
   box.appendChild(document.createTextNode(text));
   box.onclick = () => {
      textarea.value = text;
      box.remove();
   };
}

document.querySelectorAll('[data-translate]').forEach(btn => {
   btn.addEventListener('click', async () => {
      const msgid = btn.dataset.translate;
      const pair = btn.closest('.pair');
      const textarea = pair.querySelector('textarea');
      const row = btn.closest('.row');

      btn.disabled = true;
      row.classList.add('is-translating');
      try {
         const res = await fetch('/api/translate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ msgid })
         });
         const data = await res.json();
         if (!res.ok || data.error) throw new Error(data.error || 'Translation failed');
         showSuggestion(textarea, data.translation);
      } catch (err) {
         alert(err.message);
      } finally {
         btn.disabled = false;
         row.classList.remove('is-translating');
      }
   });
});
`;
