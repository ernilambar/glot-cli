import type { GlotConfig } from "../../core/config.ts";
import { runReview } from "../../core/operations/review.ts";
import type { ReviewEvent } from "../../core/operations/review.ts";
import { handleError } from "../exit.ts";
import { renderReviewReport } from "../render.ts";

function printEvent(event: ReviewEvent): void {
  switch (event.type) {
    case "reviewing":
      process.stderr.write(`Reviewing ${event.count} string(s) in ${event.input} ...\n\n`);
      break;
    case "batchFailed":
      process.stderr.write(
        `  Batch ${event.index + 1}/${event.totalBatches}: FAILED — ${event.error}  [${event.completed}/${event.totalBatches}]\n`,
      );
      break;
    case "batchDone":
      process.stderr.write(
        `  Batch ${event.index + 1}/${event.totalBatches}: done  [${event.completed}/${event.totalBatches}]\n`,
      );
      break;
  }
}

export async function runReviewCommand(config: GlotConfig, input: string, format: string, debug: boolean): Promise<void> {
  try {
    const result = await runReview({ ...config, debug }, input, format, printEvent);

    if (result.outcome === "noStrings") {
      process.stderr.write("No strings found.\n");
      return;
    }

    process.stdout.write(renderReviewReport(result.report, result.total, format, result.usage));
  } catch (err) {
    handleError(err, debug);
  }
}
