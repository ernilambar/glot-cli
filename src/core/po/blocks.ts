// Splits raw PO text into per-entry blocks, preserving file order via a
// line-scanning flush() state machine — gettext-parser groups parsed output
// by context first, msgid second, which loses file order across interleaved
// contexts. Parsing one entry at a time keeps gettext-parser as the source
// of truth for field syntax while this module alone is responsible for order.
export function splitIntoBlocks(text: string): string[] {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let state = 0; // 0=none, 1=msgctxt, 2=msgid, 3=msgid_plural, 4=msgstr
  let entryStarted = false;

  const flush = () => {
    if (!entryStarted) {
      return;
    }
    blocks.push(current.join("\n"));
    current = [];
    entryStarted = false;
    state = 0;
  };

  for (const raw of lines) {
    const l = raw.trim();

    if (l === "") {
      flush();
      continue;
    }

    if (l.startsWith("#")) {
      if (state === 2 || state === 3 || state === 4) {
        flush();
      }
      entryStarted = true;
      current.push(raw);
      continue;
    }

    if (l.startsWith("msgctxt ")) {
      if (state === 2 || state === 3 || state === 4) {
        flush();
      }
      entryStarted = true;
      current.push(raw);
      state = 1;
    } else if (l.startsWith("msgid_plural ")) {
      entryStarted = true;
      current.push(raw);
      state = 3;
    } else if (l.startsWith("msgid ")) {
      if (state === 4) {
        flush();
      }
      entryStarted = true;
      current.push(raw);
      state = 2;
    } else if (l.startsWith("msgstr[") || l.startsWith("msgstr ")) {
      entryStarted = true;
      current.push(raw);
      state = 4;
    } else {
      // Continuation line ("...) or unknown — belongs to the current entry.
      current.push(raw);
    }
  }
  flush();

  return blocks;
}
