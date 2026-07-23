import type { UsageInfo } from "../core/ai-client.ts";
import type { CoreListItem, CoreListResult } from "../core/operations/corePull.ts";
import type { GlossaryListItem, GlossaryListResult } from "../core/operations/glossaryPull.ts";
import type { ReviewItem } from "../core/operations/review.ts";
import type { StatusResult } from "../core/operations/status.ts";

export function truncateStr(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

export function formatIssueDisplay(item: ReviewItem): string {
  const parts: string[] = [];
  if (item.staticIssue !== "") {
    parts.push(item.staticIssue);
  }
  if (item.aiIssue !== "") {
    parts.push(`✨ ${item.aiIssue}`);
  }
  return parts.join("; ");
}

function tokensLine(usage: UsageInfo | null): string {
  return usage ? `Tokens: input=${usage.promptTokens}, output=${usage.completionTokens}, total=${usage.totalTokens}\n` : "";
}

function csvField(s: string): string {
  return /["\n\r,]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function csvRow(fields: string[]): string {
  return `${fields.map(csvField).join(",")}\n`;
}

// Generic tabwriter-style column layout: pads every column but the last to
// the widest line across all rows (padding=2), and renders multi-line cells
// (multi-occurrence review entries contain embedded "\n") as aligned
// sub-rows instead of corrupting the layout.
function renderTable(rows: string[][], padding: number): string {
  const numCols = rows[0]?.length ?? 0;
  const splitRows = rows.map((row) => row.map((cell) => cell.split("\n")));
  const colWidths = new Array(numCols).fill(0);
  for (const row of splitRows) {
    row.forEach((lines, col) => {
      for (const line of lines) {
        colWidths[col] = Math.max(colWidths[col], line.length);
      }
    });
  }

  let out = "";
  for (const row of splitRows) {
    const lineCount = Math.max(...row.map((lines) => lines.length));
    for (let li = 0; li < lineCount; li++) {
      const cells = row.map((lines, col) => {
        const text = lines[li] ?? "";
        return col === numCols - 1 ? text : text.padEnd(colWidths[col]! + padding);
      });
      out += `${cells.join("")}\n`;
    }
  }
  return out;
}

export function renderReviewReport(
  report: ReviewItem[],
  total: number,
  format: string,
  usage: UsageInfo | null,
): string {
  switch (format) {
    case "json": {
      const data = report.map((it) => {
        const obj: Record<string, unknown> = { num: it.num, msgid: it.msgId, occurrences: it.occurrences };
        if (it.staticIssue !== "") {
          obj.static_issue = it.staticIssue;
        }
        if (it.aiIssue !== "") {
          obj.ai_issue = it.aiIssue;
        }
        return obj;
      });
      return `${JSON.stringify(data, null, 2)}\n`;
    }

    case "markdown": {
      let out = "| # | String | Location | Issue |\n|---|--------|----------|-------|\n";
      for (const it of report) {
        const preview = truncateStr(it.msgId, 60);
        const locations = it.occurrences.length > 0 ? it.occurrences.join(", ") : "—";
        out += `| ${it.num} | ${preview} | ${locations} | ${formatIssueDisplay(it)} |\n`;
      }
      if (usage) {
        out += `\n${tokensLine(usage)}`;
      }
      return out;
    }

    case "csv": {
      let out = csvRow(["num", "msgid", "occurrences", "static_issue", "ai_issue"]);
      for (const it of report) {
        out += csvRow([String(it.num), it.msgId, it.occurrences.join("; "), it.staticIssue, it.aiIssue]);
      }
      return out;
    }

    case "table": {
      if (report.length === 0) {
        return `\nNo issues found.\n${tokensLine(usage)}`;
      }
      const rows = [
        ["#", "String", "Location", "Issue"],
        ["-", "------", "--------", "-----"],
      ];
      for (const it of report) {
        const preview = truncateStr(it.msgId, 80);
        const loc = it.occurrences.length > 0 ? it.occurrences.join("\n") : "—";
        rows.push([String(it.num), preview, loc, formatIssueDisplay(it)]);
      }
      let out = renderTable(rows, 2);
      out += `\nTotal: ${report.length} issue(s) in ${total} string(s)\n`;
      out += tokensLine(usage);
      return out;
    }

    default: {
      if (report.length === 0) {
        return `\nNo issues found.\n${tokensLine(usage)}`;
      }
      let out = `\nFound ${report.length} issue(s):\n\n`;
      for (const it of report) {
        const preview = truncateStr(it.msgId, 80);
        out += `  String: ${JSON.stringify(preview)}\n`;
        for (const occ of it.occurrences) {
          out += `  ${occ}\n`;
        }
        out += `  Issue: ${formatIssueDisplay(it)}\n\n`;
      }
      out += `Total: ${report.length} issue(s) in ${total} string(s)\n`;
      out += tokensLine(usage);
      return out;
    }
  }
}

export function renderStatus(result: StatusResult): string {
  let out = `File: ${result.input}\n\n`;
  out += `  ${"Total".padEnd(14)} ${result.total}\n`;
  out += `  ${"Translated".padEnd(14)} ${result.translated}  (${result.percentage.toFixed(1)}%)\n`;
  out += `  ${"Untranslated".padEnd(14)} ${result.untranslated}\n`;
  out += `  ${"Fuzzy".padEnd(14)} ${result.fuzzy}\n`;
  if (result.coreCache) {
    out += `\n  Core cache (${result.coreCache.lang}): ${result.coreCache.hits} of ${result.coreCache.untranslated} untranslated string(s) have cached translations\n`;
  }
  return out;
}

function renderDataList(
  items: GlossaryListItem[] | CoreListItem[],
  dataDir: string,
): string {
  let out = `Data dir: ${dataDir}\n\n`;
  out += `${"LOCALE".padEnd(12)}  ${"LAST UPDATED".padEnd(12)}  ENTRIES\n`;
  out += `${"------------".padEnd(12)}  ${"------------".padEnd(12)}  -------\n`;
  for (const item of items) {
    out += `${item.locale.padEnd(12)}  ${item.lastUpdated.padEnd(12)}  ${item.entries}\n`;
  }
  return out;
}

export function renderGlossaryList(result: GlossaryListResult): string {
  if (result.outcome === "dirNotFound") {
    return `Glossary directory not found: ${result.dir}\n`;
  }
  if (result.outcome === "empty") {
    return "No glossary files found.\n";
  }
  return renderDataList(result.items, result.dataDir);
}

export function renderCoreList(result: CoreListResult): string {
  if (result.outcome === "dirNotFound") {
    return `Core directory not found: ${result.dir}\n`;
  }
  if (result.outcome === "empty") {
    return "No core translation files found.\n";
  }
  return renderDataList(result.items, result.dataDir);
}
