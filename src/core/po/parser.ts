import { po } from "gettext-parser";
import type { GetTextTranslation } from "gettext-parser";
import { splitIntoBlocks } from "./blocks.ts";
import type { Entry } from "./types.ts";

export interface ParsedPo {
  entries: Entry[];
  // Whether the source text ended with a trailing "\n". Tracked separately
  // because the writer's per-field trailing "\n" would otherwise always
  // introduce one, even for source files exported without a final newline.
  trailingNewline: boolean;
}

function emptyEntry(): Entry {
  return {
    msgCtxt: "",
    msgId: "",
    msgIdPlural: "",
    msgStr: "",
    msgStrPlural: {},
    translatorComments: [],
    extractedComments: [],
    references: [],
    flags: [],
    obsolete: false,
    commentOrder: [],
    isHeader: false,
  };
}

// Scans raw comment-line prefixes in file order so the writer can replay
// comment kinds (translator/extracted/reference/flag) in their original
// relative order, instead of gettext-parser's fixed grouping order.
function scanCommentOrder(block: string): string[] {
  const order: string[] = [];
  for (const raw of block.split("\n")) {
    const l = raw.trim();
    if (!l.startsWith("#") || l.startsWith("#~")) {
      continue;
    }
    let kind: string;
    if (l.startsWith("#.")) {
      kind = "extracted";
    } else if (l.startsWith("#:")) {
      kind = "reference";
    } else if (l.startsWith("#,")) {
      kind = "flag";
    } else {
      kind = "translator";
    }
    if (!order.includes(kind)) {
      order.push(kind);
    }
  }
  return order;
}

function splitComment(joined: string | undefined): string[] {
  if (joined === undefined) {
    return [];
  }
  return joined.split("\n");
}

function splitFlags(joined: string | undefined): string[] {
  if (joined === undefined) {
    return [];
  }
  const out: string[] = [];
  for (const line of joined.split("\n")) {
    for (const f of line.split(",")) {
      const trimmed = f.trim();
      if (trimmed !== "") {
        out.push(trimmed);
      }
    }
  }
  return out;
}

function firstEntry(
  bucket: Record<string, Record<string, GetTextTranslation>> | undefined,
): GetTextTranslation | undefined {
  if (!bucket) {
    return undefined;
  }
  for (const ctx of Object.keys(bucket)) {
    for (const msgid of Object.keys(bucket[ctx]!)) {
      return bucket[ctx]![msgid];
    }
  }
  return undefined;
}

function fromRaw(raw: GetTextTranslation, obsolete: boolean, commentOrder: string[]): Entry {
  const e = emptyEntry();
  e.msgCtxt = raw.msgctxt ?? "";
  e.msgId = raw.msgid;
  e.msgIdPlural = raw.msgid_plural ?? "";
  e.obsolete = obsolete;
  e.commentOrder = commentOrder;

  if (e.msgIdPlural !== "") {
    raw.msgstr.forEach((v, i) => {
      e.msgStrPlural[i] = v;
    });
  } else {
    e.msgStr = raw.msgstr[0] ?? "";
  }

  const comments = raw.comments;
  e.translatorComments = splitComment(comments?.translator);
  e.extractedComments = splitComment(comments?.extracted);
  e.references = splitComment(comments?.reference);
  e.flags = splitFlags(comments?.flag);

  e.isHeader = e.msgCtxt === "" && e.msgId === "" && !obsolete;

  return e;
}

// Parses PO content into an ordered Entry[], preserving file order exactly —
// including interleaved msgctxt entries — by delegating each individual
// entry's field parsing to gettext-parser while this module supplies order.
export function parsePo(text: string): ParsedPo {
  if (!text.includes("msgid")) {
    throw new Error("no msgid found; not a PO file");
  }

  const blocks = splitIntoBlocks(text);
  const entries: Entry[] = [];

  for (const block of blocks) {
    const table = po.parse(block, { validation: false });
    const commentOrder = scanCommentOrder(block);
    const obsoleteRaw = firstEntry(table.obsolete as never);
    if (obsoleteRaw) {
      entries.push(fromRaw(obsoleteRaw, true, commentOrder));
      continue;
    }
    const raw = firstEntry(table.translations as never);
    if (raw) {
      entries.push(fromRaw(raw, false, commentOrder));
    }
  }

  return { entries, trailingNewline: text.endsWith("\n") };
}
