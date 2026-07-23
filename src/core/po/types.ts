export interface Entry {
  msgCtxt: string;
  msgId: string;
  msgIdPlural: string;
  msgStr: string;
  msgStrPlural: Record<number, string>;

  translatorComments: string[];
  extractedComments: string[];
  references: string[];
  flags: string[];
  obsolete: boolean;

  // First-seen order of comment kinds ("translator" | "extracted" | "reference" | "flag")
  // for this entry. gettext-parser groups comments by kind and discards which kind's
  // block came first in the source — this field is scanned from the raw block text
  // separately so the writer can replay entries whose comment kinds aren't in gettext's
  // conventional order (translator, extracted, reference, flag) without reformatting them.
  commentOrder: string[];

  isHeader: boolean;
}
