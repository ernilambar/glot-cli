import yargs from "yargs";
import { VERSION } from "../core/config.ts";
import type { GlotConfig } from "../core/config.ts";
import { runCoreListCommand, runCorePullCommand } from "./commands/core.ts";
import { runGlossaryListCommand, runGlossaryPullCommand } from "./commands/glossary.ts";
import { runReviewCommand } from "./commands/review.ts";
import { runServeCommand } from "./commands/serve.ts";
import { runStatusCommand } from "./commands/status.ts";
import { runTranslateCommand } from "./commands/translate.ts";
import { loadConfigFromEnv } from "./env.ts";
import { exit } from "./exit.ts";

const HELP_TEXT = `glot - Translate WordPress .po files using any OpenAI-compatible backend.

USAGE
  glot <command> [options]

COMMANDS
  translate <file> [--lang <code>] [--limit <n>]
      Translate missing entries in a .po file.

  review <file> [--format text|table|json|csv|markdown]
      Review strings in a .po/.pot file for i18n issues.

  status <file> [--lang <code>]
      Show translation progress for a .po file.

  serve <file> [--lang <code>] [--port <n>] [--no-open]
      Open a browser-based editor for a .po file.

  glossary list
  glossary pull [<locale>]
      Manage glossary files.

  core list
  core pull [<locale>]
      Manage core translation cache.

  -V, --version   Show version and exit.
  -h, --help      Show this help.

ENVIRONMENT
  GLOT_ENDPOINT_URL   OpenAI-compatible base URL, e.g. http://host/v1 (required)
  GLOT_MODEL_ID       Model ID (required)
  GLOT_API_KEY        API key (optional for local backends)
  GLOT_LANG           Default target locale code (e.g. ne_NP)
  GLOT_DATA_DIR       Data directory (default: ~/.config/glot-cli)
  GLOT_MAX_STRINGS    Max strings per translate run (default: 200)
  GLOT_BATCH_SIZE     Strings per API call (default: 10)
  GLOT_CONCURRENCY    Parallel API calls (default: 1)
  GLOT_REQUEST_TIMEOUT Request timeout in seconds (default: 120; 0 disables)
`;

export async function runCli(argv: string[], config: GlotConfig = loadConfigFromEnv()): Promise<void> {
  if (argv.length === 0) {
    process.stdout.write(HELP_TEXT);
    exit(0);
  }

  await yargs(argv)
    .scriptName("glot")
    .usage(HELP_TEXT)
    .version(VERSION)
    .alias("version", "V")
    .alias("help", "h")
    .fail((msg, err) => {
      if (err) {
        throw err;
      }
      process.stderr.write(`Error: ${msg}\n`);
      exit(2);
    })
    .command(
      "translate <file>",
      "Translate missing entries in a .po file.",
      (y) =>
        y
          .positional("file", { type: "string", demandOption: true, describe: "Input .po file" })
          .option("lang", { type: "string", default: config.lang, describe: "Target locale code (overrides GLOT_LANG)" })
          .option("limit", { type: "number", default: 0, describe: "Max strings this run (0 = GLOT_MAX_STRINGS)" })
          .option("debug", { type: "boolean", default: false, describe: "Show raw technical detail alongside error messages" }),
      async (args) => {
        const lang = args.lang as string;
        if (!lang) {
          process.stderr.write("Error: --lang is required (or set GLOT_LANG env variable)\n");
          exit(2);
        }
        await runTranslateCommand(config, args.file as string, lang, args.limit as number, args.debug as boolean);
      },
    )
    .command(
      "review <file>",
      "Review strings in a .po/.pot file for i18n issues.",
      (y) =>
        y
          .positional("file", { type: "string", demandOption: true, describe: "Input .po/.pot file" })
          .option("format", {
            type: "string",
            choices: ["text", "table", "json", "csv", "markdown"],
            default: "text",
            describe: "Output format",
          })
          .option("debug", { type: "boolean", default: false, describe: "Show raw technical detail alongside error messages" }),
      async (args) => {
        await runReviewCommand(config, args.file as string, args.format as string, args.debug as boolean);
      },
    )
    .command(
      "status <file>",
      "Show translation progress for a .po file.",
      (y) =>
        y
          .positional("file", { type: "string", demandOption: true, describe: "Input .po file" })
          .option("lang", { type: "string", default: config.lang, describe: "Locale for core cache check" }),
      (args) => {
        runStatusCommand(config, args.file as string, args.lang as string);
      },
    )
    .command(
      "serve <file>",
      "Open a browser-based editor for a .po file.",
      (y) =>
        y
          .positional("file", { type: "string", demandOption: true, describe: "Input .po file" })
          .option("lang", {
            type: "string",
            default: config.lang,
            describe: "Target locale code for AI-translate (overrides GLOT_LANG); editing/saving works without it",
          })
          .option("port", { type: "number", default: 49700, describe: "Port to serve on" })
          .option("open", { type: "boolean", default: true, describe: "Open the browser automatically" })
          .option("debug", { type: "boolean", default: false, describe: "Show raw technical detail alongside error messages" }),
      (args) => {
        runServeCommand(
          config,
          args.file as string,
          args.lang as string,
          args.port as number,
          args.open as boolean,
          args.debug as boolean,
        );
      },
    )
    .command(
      "glossary",
      "Manage glossary files.",
      (y) =>
        y
          .command(
            "list",
            "List glossary files.",
            () => {},
            () => runGlossaryListCommand(config),
          )
          .command(
            "pull [locale]",
            "Pull a glossary file.",
            (yy) => yy.positional("locale", { type: "string", default: config.lang }),
            async (args) => runGlossaryPullCommand(config, (args.locale as string | undefined) ?? ""),
          )
          .demandCommand(1, "glossary requires a subcommand: list, pull"),
      () => {},
    )
    .command(
      "core",
      "Manage core translation cache.",
      (y) =>
        y
          .command(
            "list",
            "List core translation files.",
            () => {},
            () => runCoreListCommand(config),
          )
          .command(
            "pull [locale]",
            "Pull core translations.",
            (yy) => yy.positional("locale", { type: "string", default: config.lang }),
            async (args) => runCorePullCommand(config, (args.locale as string | undefined) ?? ""),
          )
          .demandCommand(1, "core requires a subcommand: list, pull"),
      () => {},
    )
    .demandCommand(1, "a command is required")
    .strict()
    .parseAsync();
}
