import type { Entry } from "./types.ts";

// Ported from gotext.EscapeSpecialCharacters as actually exercised by
// po.go's writePOField: values are always pre-split on "\n" before reaching
// this function, so only the unescaped-double-quote regex ever fires. Matches
// Go's escaping exactly, quirks included (e.g. a leading quote at index 0 is
// not escaped, since the Go regex requires a preceding non-backslash char).
function escapeSpecialCharacters(s: string): string {
  return s.replace(/([^\\])(")/g, '$1\\"');
}

function writePOField(field: string, value: string): string {
  if (value.includes("\n")) {
    let lines = value.split("\n");
    let trailing = "";
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines = lines.slice(0, -1);
      trailing = "\\n";
    }
    let out = `${field} ""\n`;
    lines.forEach((ln, i) => {
      const end = i === lines.length - 1 && trailing === "" ? "" : "\\n";
      out += `"${escapeSpecialCharacters(ln)}${end}"\n`;
    });
    return out;
  }
  return `${field} "${escapeSpecialCharacters(value)}"\n`;
}

const DEFAULT_COMMENT_ORDER = ["translator", "extracted", "reference", "flag"];

function writeCommentKind(kind: string, e: Entry): string {
  switch (kind) {
    case "translator":
      return e.translatorComments.map((c) => (c === "" ? "#\n" : `# ${c}\n`)).join("");
    case "extracted":
      return e.extractedComments.map((c) => `#. ${c}\n`).join("");
    case "reference":
      return e.references.map((r) => `#: ${r}\n`).join("");
    case "flag":
      return e.flags.length > 0 ? `#, ${e.flags.join(", ")}\n` : "";
    default:
      return "";
  }
}

function writeEntry(e: Entry): string {
  const prefix = e.obsolete ? "#~ " : "";
  let out = "";

  if (!e.obsolete) {
    const order = e.commentOrder.length > 0 ? e.commentOrder : DEFAULT_COMMENT_ORDER;
    for (const kind of order) {
      out += writeCommentKind(kind, e);
    }
  }

  if (e.msgCtxt !== "") {
    out += writePOField(`${prefix}msgctxt`, e.msgCtxt);
  }
  out += writePOField(`${prefix}msgid`, e.msgId);

  if (e.msgIdPlural !== "") {
    out += writePOField(`${prefix}msgid_plural`, e.msgIdPlural);
    let max = -1;
    for (const k of Object.keys(e.msgStrPlural)) {
      const idx = Number(k);
      if (idx > max) {
        max = idx;
      }
    }
    for (let i = 0; i <= max; i++) {
      out += writePOField(`${prefix}msgstr[${i}]`, e.msgStrPlural[i] ?? "");
    }
    if (max === -1) {
      out += writePOField(`${prefix}msgstr[0]`, "");
      out += writePOField(`${prefix}msgstr[1]`, "");
    }
  } else {
    out += writePOField(`${prefix}msgstr`, e.msgStr);
  }

  return out;
}

export function marshalPo(entries: Entry[], trailingNewline = true): string {
  let out = "";
  entries.forEach((e, i) => {
    if (i > 0) {
      out += "\n";
    }
    out += writeEntry(e);
  });
  if (!trailingNewline && out.endsWith("\n")) {
    out = out.slice(0, -1);
  }
  return out;
}
