import type { EditorRow } from "../../core/operations/serveEditor.ts";
import { STYLE_CSS, SCRIPT_JS } from "./assets.ts";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const ICON_COPY =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="5" y="5" width="8" height="8" rx="1.5"></rect><path d="M3 10V3a1 1 0 0 1 1-1h7"></path></svg>';
const ICON_FILL =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 2v7"></path><path d="M4.5 6.5 8 10l3.5-3.5"></path><rect x="3" y="11" width="10" height="3" rx="1"></rect></svg>';
const ICON_TRANSLATE =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M8 1.2 L9.5 6.3 L14.8 8 L9.5 9.7 L8 14.8 L6.5 9.7 L1.2 8 L6.5 6.3 Z"></path><path d="M13 1 L14 2.1 L13 3.2 L12 2.1 Z"></path></svg>';

function textareaRows(value: string): number {
  return Math.min(6, Math.max(2, Math.floor(value.length / 60) + 1));
}

function renderMsgidCol(row: EditorRow): string {
  const e = row.entry;
  const parts: string[] = [];
  parts.push('<div class="msgid-row">');
  parts.push(`<div class="msgid">${escapeHtml(e.msgId)}</div>`);
  parts.push(
    `<button type="button" class="icon-btn" data-copy="${escapeHtml(e.msgId)}" title="Copy source">${ICON_COPY}</button>`,
  );
  parts.push("</div>");
  if (e.extractedComments.length > 0) {
    parts.push(`<span class="row-context">${escapeHtml(e.extractedComments.join(" "))}</span>`);
  }
  if (e.msgCtxt !== "") {
    parts.push(`<span class="row-context">${escapeHtml(e.msgCtxt)}</span>`);
  }
  if (e.references.length > 0) {
    parts.push(`<div class="row-occurrences">${escapeHtml(e.references.slice(0, 3).join("  ·  "))}</div>`);
  }
  return parts.join("");
}

function renderApprovedSuggestions(matches: string[] | undefined): string {
  if (!matches || matches.length === 0) {
    return "";
  }
  return matches
    .map(
      (m) =>
        `<div class="translate-suggestion approved" data-suggestion="${escapeHtml(m)}" title="Click to use this translation"><span class="suggestion-tag">WP</span>${escapeHtml(m)}</div>`,
    )
    .join("");
}

function renderTranslateButton(msgId: string, glotEnabled: boolean): string {
  if (!glotEnabled) {
    return "";
  }
  return `<button type="button" class="icon-btn" data-translate="${escapeHtml(msgId)}" title="Translate with AI">${ICON_TRANSLATE}</button>`;
}

function renderRow(row: EditorRow, nplurals: number, glotEnabled: boolean): string {
  const e = row.entry;
  const searchBlob = [e.msgId, e.msgStr, ...Object.values(e.msgStrPlural)].join(" ").toLowerCase();

  let body: string;
  if (e.msgIdPlural !== "") {
    const first = `
      <div class="pair">
        <div class="msgid-col">${renderMsgidCol(row)}</div>
        <div>
          <div class="plural-label">msgstr[0]</div>
          <div class="msgstr-row">
            <textarea name="entry_${row.displayPos}_msgstr_plural_0" rows="2">${escapeHtml(e.msgStrPlural[0] ?? "")}</textarea>
            <button type="button" class="icon-btn" data-fill="${escapeHtml(e.msgId)}" title="Copy source to translation">${ICON_FILL}</button>
            ${renderTranslateButton(e.msgId, glotEnabled)}
          </div>
        </div>
      </div>`;
    const rest: string[] = [];
    for (let p = 1; p < nplurals; p++) {
      rest.push(`
      <div class="pair">
        <div class="msgid-row">
          <div class="msgid">${escapeHtml(e.msgIdPlural)}</div>
          <button type="button" class="icon-btn" data-copy="${escapeHtml(e.msgIdPlural)}" title="Copy source">${ICON_COPY}</button>
        </div>
        <div>
          <div class="plural-label">msgstr[${p}]</div>
          <div class="msgstr-row">
            <textarea name="entry_${row.displayPos}_msgstr_plural_${p}" rows="2">${escapeHtml(e.msgStrPlural[p] ?? "")}</textarea>
            <button type="button" class="icon-btn" data-fill="${escapeHtml(e.msgIdPlural)}" title="Copy source to translation">${ICON_FILL}</button>
            ${renderTranslateButton(e.msgIdPlural, glotEnabled)}
          </div>
        </div>
      </div>`);
    }
    body = first + rest.join("");
  } else {
    body = `
      <div class="pair">
        <div class="msgid-col">${renderMsgidCol(row)}</div>
        <div class="msgstr-row">
          <textarea name="entry_${row.displayPos}_msgstr" rows="${textareaRows(e.msgStr)}">${escapeHtml(e.msgStr)}</textarea>
          <button type="button" class="icon-btn" data-fill="${escapeHtml(e.msgId)}" title="Copy source to translation">${ICON_FILL}</button>
          ${renderTranslateButton(e.msgId, glotEnabled)}
          ${renderApprovedSuggestions(row.coreMatches)}
        </div>
      </div>`;
  }

  return `
    <div class="row" data-status="${row.status}" data-search="${escapeHtml(searchBlob)}">
      <div class="gutter status-${row.status}"></div>
      <div class="row-body">${body}</div>
      <div class="row-meta">
        <span class="row-index" data-toggle="occurrences">#${row.displayPos + 1}</span>
      </div>
    </div>`;
}

export interface RenderPageOptions {
  filename: string;
  nplurals: number;
  glotEnabled: boolean;
  message?: string;
}

export function renderPage(rows: EditorRow[], opts: RenderPageOptions): string {
  const total = rows.length;
  const untranslated = rows.filter((r) => r.status === "untranslated").length;
  const fuzzy = rows.filter((r) => r.status === "fuzzy").length;
  const translated = total - untranslated - fuzzy;

  const filterGroup =
    total > 0
      ? `
    <div class="filter-group">
      <button type="button" class="filter-btn active" data-filter="all">All (${total})</button>
      <button type="button" class="filter-btn" data-filter="translated">Translated (${translated})</button>
      <button type="button" class="filter-btn" data-filter="untranslated">Untranslated (${untranslated})</button>
      <button type="button" class="filter-btn" data-filter="fuzzy">Fuzzy (${fuzzy})</button>
    </div>
    <input type="search" id="search" placeholder="Search msgid or translation…">`
      : "";

  const saveButton = total > 0 ? '<button type="submit" form="editForm" class="btn primary">Save</button>' : "";

  const banner = opts.message ? `<div class="banner">${escapeHtml(opts.message)}</div>` : "";

  const main =
    total > 0
      ? `<form method="post" action="/save" id="editForm"><main>${banner}${rows.map((r) => renderRow(r, opts.nplurals, opts.glotEnabled)).join("")}</main></form>`
      : `<main>${banner}<div class="empty-state"><h2>No translatable strings</h2><p>This file has no entries to edit.</p></div></main>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Glot Editor</title>
<style>${STYLE_CSS}</style>
</head>
<body>
<header>
  <h1>Glot Editor</h1>
  <span class="filename">${escapeHtml(opts.filename)}</span>
  ${filterGroup}
  ${saveButton}
</header>
${main}
<script>${SCRIPT_JS}</script>
</body>
</html>
`;
}
