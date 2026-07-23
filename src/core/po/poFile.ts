import { readFileSync, writeFileSync } from "node:fs";
import { isFuzzy, isTranslated } from "./entry.ts";
import { parsePo } from "./parser.ts";
import type { Entry } from "./types.ts";
import { marshalPo } from "./writer.ts";

// An ordered, order-preserving collection of entries.
export class PoFile {
  entries: Entry[];
  private trailingNewline: boolean;

  constructor(entries: Entry[], trailingNewline = true) {
    this.entries = entries;
    this.trailingNewline = trailingNewline;
  }

  static parse(text: string): PoFile {
    const { entries, trailingNewline } = parsePo(text);
    return new PoFile(entries, trailingNewline);
  }

  static parseFile(path: string): PoFile {
    return PoFile.parse(readFileSync(path, "utf8"));
  }

  total(): number {
    return this.entries.filter((e) => !e.obsolete && !e.isHeader).length;
  }

  translatedCount(): number {
    return this.entries.filter((e) => !e.obsolete && !e.isHeader && isTranslated(e)).length;
  }

  untranslatedCount(): number {
    return this.entries.filter((e) => !e.obsolete && !e.isHeader && !isTranslated(e) && !isFuzzy(e)).length;
  }

  fuzzyCount(): number {
    return this.entries.filter((e) => !e.obsolete && !e.isHeader && isFuzzy(e)).length;
  }

  translatableEntries(): Entry[] {
    return this.entries.filter((e) => !e.obsolete && !e.isHeader);
  }

  marshal(): string {
    return marshalPo(this.entries, this.trailingNewline);
  }

  save(path: string): void {
    writeFileSync(path, this.marshal());
  }
}
