import assert from "node:assert/strict";
import { test } from "node:test";
import { GlotValidationError } from "../../src/core/errors.ts";
import { validateLang } from "../../src/core/languages.ts";

const fakeLanguages = { ne_NP: "Nepali", es_ES: "Spanish (Spain)" };

test("validateLang: valid locale passes", () => {
  assert.doesNotThrow(() => validateLang("ne_NP", fakeLanguages));
});

test("validateLang: invalid locale throws GlotValidationError", () => {
  assert.throws(() => validateLang("xx_XX", fakeLanguages), GlotValidationError);
});

test("validateLang: skips validation when language list is empty", () => {
  assert.doesNotThrow(() => validateLang("xx_XX", {}));
});
