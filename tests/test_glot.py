import pytest
import polib
import requests
from unittest.mock import patch, Mock

import glot


# ---------------------------------------------------------------------------
# parse_batch_response
# ---------------------------------------------------------------------------

class TestParseBatchResponse:
    def test_json_response(self):
        r = '{"1": "नमस्ते", "2": "संसार"}'
        assert glot.parse_batch_response(r, 2) == ["नमस्ते", "संसार"]

    def test_json_with_code_fences(self):
        r = '```json\n{"1": "नमस्ते"}\n```'
        assert glot.parse_batch_response(r, 1) == ["नमस्ते"]

    def test_json_missing_key_returns_empty(self):
        r = '{"1": "नमस्ते"}'
        assert glot.parse_batch_response(r, 2) == ["नमस्ते", ""]

    def test_json_ignores_out_of_range_keys(self):
        r = '{"1": "A", "9": "B"}'
        assert glot.parse_batch_response(r, 2) == ["A", ""]

    def test_regex_fallback(self):
        r = "1. नमस्ते\n2. संसार"
        assert glot.parse_batch_response(r, 2) == ["नमस्ते", "संसार"]

    def test_malformed_json_falls_back_to_regex(self):
        r = "{bad json}\n1. नमस्ते\n2. संसार"
        assert glot.parse_batch_response(r, 2) == ["नमस्ते", "संसार"]

    def test_empty_response_returns_empty_strings(self):
        assert glot.parse_batch_response("", 2) == ["", ""]


# ---------------------------------------------------------------------------
# tokenize
# ---------------------------------------------------------------------------

class TestTokenize:
    def test_basic(self):
        assert glot.tokenize("Hello World") == ["hello", "world"]

    def test_punctuation_stripped(self):
        assert glot.tokenize("Hello, World!") == ["hello", "world"]

    def test_empty_string(self):
        assert glot.tokenize("") == []


# ---------------------------------------------------------------------------
# build_glossary_index
# ---------------------------------------------------------------------------

class TestBuildGlossaryIndex:
    def test_single_word_term(self):
        glossary = {"plugin": {"translation": "प्लगिन", "pos": "", "note": ""}}
        index = glot.build_glossary_index(glossary)
        assert "plugin" in index["plugin"]

    def test_multi_word_term_indexed_by_first_word(self):
        glossary = {"admin panel": {"translation": "व्यवस्थापक प्यानल", "pos": "", "note": ""}}
        index = glot.build_glossary_index(glossary)
        assert "admin panel" in index["admin"]


# ---------------------------------------------------------------------------
# matching_glossary_terms
# ---------------------------------------------------------------------------

class TestMatchingGlossaryTerms:
    def setup_method(self):
        self.glossary = {
            "plugin": {"translation": "प्लगिन", "pos": "noun", "note": ""},
            "admin panel": {"translation": "व्यवस्थापक प्यानल", "pos": "noun", "note": ""},
        }
        self.index = glot.build_glossary_index(self.glossary)

    def test_single_word_match(self):
        matches = glot.matching_glossary_terms("Install plugin", self.glossary, self.index)
        assert [t for t, _ in matches] == ["plugin"]

    def test_multi_word_match(self):
        matches = glot.matching_glossary_terms("Open the admin panel now", self.glossary, self.index)
        assert [t for t, _ in matches] == ["admin panel"]

    def test_no_match(self):
        assert glot.matching_glossary_terms("Hello World", self.glossary, self.index) == []

    def test_empty_glossary(self):
        assert glot.matching_glossary_terms("Install plugin", {}, {}) == []

    def test_case_insensitive(self):
        matches = glot.matching_glossary_terms("Install Plugin", self.glossary, self.index)
        assert [t for t, _ in matches] == ["plugin"]


# ---------------------------------------------------------------------------
# build_batch_prompt
# ---------------------------------------------------------------------------

class TestBuildBatchPrompt:
    def test_numbered_strings_present(self):
        items = [("Hello", []), ("World", [])]
        prompt = glot.build_batch_prompt(items, "ne_NP", None)
        assert "1. Hello" in prompt
        assert "2. World" in prompt

    def test_json_format_instruction_present(self):
        items = [("Hello", [])]
        prompt = glot.build_batch_prompt(items, "ne_NP", None)
        assert "JSON" in prompt

    def test_glossary_terms_injected(self):
        matches = [("plugin", {"translation": "प्लगिन", "pos": "noun", "note": ""})]
        items = [("Install plugin", matches)]
        prompt = glot.build_batch_prompt(items, "ne_NP", None)
        assert "plugin" in prompt
        assert "प्लगिन" in prompt

    def test_duplicate_glossary_terms_deduplicated(self):
        matches = [("plugin", {"translation": "प्लगिन", "pos": "", "note": ""})]
        items = [("Install plugin", matches), ("Delete plugin", matches)]
        prompt = glot.build_batch_prompt(items, "ne_NP", None)
        assert prompt.count("प्लगिन") == 1

    def test_with_system_prompt_uses_short_format(self):
        items = [("Hello", []), ("World", [])]
        prompt = glot.build_batch_prompt(items, "ne_NP", "You are a translator.")
        assert "1. Hello" in prompt
        assert "2. World" in prompt


# ---------------------------------------------------------------------------
# cmd_status
# ---------------------------------------------------------------------------

class TestCmdStatus:
    PO_CONTENT = """\
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Hello"
msgstr "नमस्ते"

msgid "World"
msgstr "संसार"

msgid "Untranslated string"
msgstr ""

#, fuzzy
msgid "Fuzzy entry"
msgstr "अस्पष्ट"
"""

    @pytest.fixture
    def po_file(self, tmp_path):
        f = tmp_path / "test.po"
        f.write_text(self.PO_CONTENT, encoding="utf-8")
        return str(f)

    def test_output_contains_section_labels(self, po_file, capsys):
        args = type("Args", (), {"input": po_file, "lang": None})()
        glot.cmd_status(args)
        out = capsys.readouterr().out
        assert "Total" in out
        assert "Translated" in out
        assert "Untranslated" in out
        assert "Fuzzy" in out

    def test_counts_are_correct(self, po_file, capsys):
        args = type("Args", (), {"input": po_file, "lang": None})()
        glot.cmd_status(args)
        out = capsys.readouterr().out
        assert "4" in out   # total
        assert "2" in out   # translated
        assert "1" in out   # untranslated / fuzzy

    def test_missing_file_exits(self, capsys):
        args = type("Args", (), {"input": "/nonexistent/file.po", "lang": None})()
        with pytest.raises(SystemExit):
            glot.cmd_status(args)

    def test_unreadable_file_exits(self, po_file):
        args = type("Args", (), {"input": po_file, "lang": None})()
        with patch("glot.polib.pofile", side_effect=PermissionError("Permission denied")):
            with pytest.raises(SystemExit):
                glot.cmd_status(args)


# ---------------------------------------------------------------------------
# call_ai_translate
# ---------------------------------------------------------------------------

class TestCallAiTranslate:
    def _make_response(self, content, status_code=200):
        r = Mock()
        r.status_code = status_code
        r.json.return_value = {"choices": [{"message": {"content": content}}]}
        r.raise_for_status = Mock()
        return r

    def test_returns_ai_content(self):
        with patch("glot.requests.post", return_value=self._make_response("नमस्ते")), \
             patch("glot.GLOT_ENDPOINT_URL", "http://fake/v1/chat"), \
             patch("glot.GLOT_MODEL_ID", "test-model"):
            assert glot.call_ai_translate("Translate: Hello") == "नमस्ते"

    def test_sends_system_prompt_as_system_message(self):
        with patch("glot.requests.post", return_value=self._make_response("ok")) as mock_post, \
             patch("glot.GLOT_ENDPOINT_URL", "http://fake/v1/chat"), \
             patch("glot.GLOT_MODEL_ID", "test-model"):
            glot.call_ai_translate("prompt", system_prompt="You are a translator.")
        messages = mock_post.call_args.kwargs["json"]["messages"]
        assert messages[0] == {"role": "system", "content": "You are a translator."}

    def test_retries_on_429(self):
        rate_limit = Mock()
        rate_limit.status_code = 429
        success = self._make_response("संसार")

        with patch("glot.requests.post", side_effect=[rate_limit, success]), \
             patch("glot.GLOT_ENDPOINT_URL", "http://fake/v1/chat"), \
             patch("glot.GLOT_MODEL_ID", "test-model"), \
             patch("time.sleep"):
            assert glot.call_ai_translate("Translate: World") == "संसार"

    def test_http_error_raises(self):
        r = Mock()
        r.status_code = 500
        r.raise_for_status.side_effect = requests.HTTPError("500 Server Error")

        with patch("glot.requests.post", return_value=r), \
             patch("glot.GLOT_ENDPOINT_URL", "http://fake/v1/chat"), \
             patch("glot.GLOT_MODEL_ID", "test-model"):
            with pytest.raises(requests.HTTPError):
                glot.call_ai_translate("Translate: Error")


# ---------------------------------------------------------------------------
# cmd_translate
# ---------------------------------------------------------------------------

class TestCmdTranslate:
    _PO_UNTRANSLATED = """\
msgid ""
msgstr ""
"Content-Type: text/plain; charset=UTF-8\\n"

msgid "Hello"
msgstr ""

msgid "World"
msgstr ""
"""

    @pytest.fixture
    def po_file(self, tmp_path):
        f = tmp_path / "test.po"
        f.write_text(self._PO_UNTRANSLATED, encoding="utf-8")
        return str(f)

    def test_missing_env_vars_exits(self, po_file):
        args = type("Args", (), {"input": po_file, "lang": "ne_NP", "limit": 0})()
        with patch("glot.GLOT_ENDPOINT_URL", None), patch("glot.GLOT_MODEL_ID", None):
            with pytest.raises(SystemExit):
                glot.cmd_translate(args)

    def test_missing_file_exits(self):
        args = type("Args", (), {"input": "/no/such/file.po", "lang": "ne_NP", "limit": 0})()
        with patch("glot.GLOT_ENDPOINT_URL", "http://fake"), patch("glot.GLOT_MODEL_ID", "m"):
            with pytest.raises(SystemExit):
                glot.cmd_translate(args)

    def test_nothing_to_do_when_fully_translated(self, tmp_path, capsys):
        content = (
            'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n\n'
            'msgid "Hello"\nmsgstr "नमस्ते"\n'
        )
        f = tmp_path / "done.po"
        f.write_text(content, encoding="utf-8")
        args = type("Args", (), {"input": str(f), "lang": "ne_NP", "limit": 0})()
        with patch("glot.GLOT_ENDPOINT_URL", "http://fake"), patch("glot.GLOT_MODEL_ID", "m"):
            glot.cmd_translate(args)
        assert "Nothing to do" in capsys.readouterr().out

    def test_ai_translations_written_to_file(self, po_file, capsys):
        args = type("Args", (), {"input": po_file, "lang": "ne_NP", "limit": 0})()
        with patch("glot.GLOT_ENDPOINT_URL", "http://fake"), \
             patch("glot.GLOT_MODEL_ID", "m"), \
             patch("glot.call_ai_translate", return_value='{"1": "नमस्ते", "2": "संसार"}'):
            glot.cmd_translate(args)
        po = polib.pofile(po_file)
        strings = {e.msgid: e.msgstr for e in po}
        assert strings["Hello"] == "नमस्ते"
        assert strings["World"] == "संसार"

    def test_unreadable_po_exits(self, po_file):
        args = type("Args", (), {"input": po_file, "lang": "ne_NP", "limit": 0})()
        with patch("glot.GLOT_ENDPOINT_URL", "http://fake"), \
             patch("glot.GLOT_MODEL_ID", "m"), \
             patch("glot.polib.pofile", side_effect=PermissionError("Permission denied")):
            with pytest.raises(SystemExit):
                glot.cmd_translate(args)

    def test_unwritable_po_exits(self, po_file):
        import os
        if os.getuid() == 0:
            pytest.skip("chmod has no effect as root")
        os.chmod(po_file, 0o444)
        args = type("Args", (), {"input": po_file, "lang": "ne_NP", "limit": 0})()
        with patch("glot.GLOT_ENDPOINT_URL", "http://fake"), \
             patch("glot.GLOT_MODEL_ID", "m"), \
             patch("glot.call_ai_translate", return_value='{"1": "नमस्ते", "2": "संसार"}'):
            with pytest.raises(SystemExit):
                glot.cmd_translate(args)

    def test_core_cache_skips_ai(self, po_file, capsys):
        core = {"Hello": "नमस्ते", "World": "संसार"}
        args = type("Args", (), {"input": po_file, "lang": "ne_NP", "limit": 0})()
        with patch("glot.GLOT_ENDPOINT_URL", "http://fake"), \
             patch("glot.GLOT_MODEL_ID", "m"), \
             patch("glot.load_core_translations", return_value=core), \
             patch("glot.call_ai_translate") as mock_ai:
            glot.cmd_translate(args)
        mock_ai.assert_not_called()
        assert "Core matches: 2" in capsys.readouterr().out

    def test_negative_limit_exits(self, po_file):
        args = type("Args", (), {"input": po_file, "lang": "ne_NP", "limit": -1})()
        with patch("glot.GLOT_ENDPOINT_URL", "http://fake"), patch("glot.GLOT_MODEL_ID", "m"):
            with pytest.raises(SystemExit):
                glot.cmd_translate(args)

    def test_invalid_po_file_exits(self, tmp_path):
        f = tmp_path / "not_a_po.txt"
        f.write_text("this is not a po file\njust plain text\n", encoding="utf-8")
        args = type("Args", (), {"input": str(f), "lang": "ne_NP", "limit": 0})()
        with patch("glot.GLOT_ENDPOINT_URL", "http://fake"), patch("glot.GLOT_MODEL_ID", "m"):
            with pytest.raises(SystemExit):
                glot.cmd_translate(args)


# ---------------------------------------------------------------------------
# cmd_glossary_pull / cmd_core_pull — locale validation
# ---------------------------------------------------------------------------

class TestLocaleValidation:
    def test_glossary_pull_no_locale_exits(self):
        args = type("Args", (), {"locale": None})()
        with pytest.raises(SystemExit):
            glot.cmd_glossary_pull(args)

    def test_glossary_pull_invalid_locale_exits(self):
        args = type("Args", (), {"locale": "xx_XX"})()
        with patch("glot.load_valid_languages", return_value=_FAKE_LANGUAGES):
            with pytest.raises(SystemExit):
                glot.cmd_glossary_pull(args)

    def test_core_pull_no_locale_exits(self):
        args = type("Args", (), {"locale": None})()
        with pytest.raises(SystemExit):
            glot.cmd_core_pull(args)

    def test_core_pull_invalid_locale_exits(self):
        args = type("Args", (), {"locale": "xx_XX"})()
        with patch("glot.load_valid_languages", return_value=_FAKE_LANGUAGES):
            with pytest.raises(SystemExit):
                glot.cmd_core_pull(args)


# ---------------------------------------------------------------------------
# validate_lang
# ---------------------------------------------------------------------------

_FAKE_LANGUAGES = {"ne_NP": "Nepali", "es_ES": "Spanish (Spain)"}


class TestValidateLang:
    def test_valid_lang_passes(self):
        with patch("glot.load_valid_languages", return_value=_FAKE_LANGUAGES):
            glot.validate_lang("ne_NP")  # must not raise or exit

    def test_invalid_lang_exits(self):
        with patch("glot.load_valid_languages", return_value=_FAKE_LANGUAGES):
            with pytest.raises(SystemExit):
                glot.validate_lang("xx_XX")

    def test_skipped_when_language_file_missing(self):
        with patch("glot.load_valid_languages", return_value={}):
            glot.validate_lang("xx_XX")  # no file → no validation → no exit

    def test_cmd_translate_rejects_invalid_lang(self, tmp_path):
        f = tmp_path / "test.po"
        f.write_text('msgid ""\nmsgstr ""\n', encoding="utf-8")
        args = type("Args", (), {"input": str(f), "lang": "xx_XX", "limit": 0})()
        with patch("glot.GLOT_ENDPOINT_URL", "http://fake"), \
             patch("glot.GLOT_MODEL_ID", "m"), \
             patch("glot.load_valid_languages", return_value=_FAKE_LANGUAGES):
            with pytest.raises(SystemExit):
                glot.cmd_translate(args)

    def test_cmd_status_rejects_invalid_lang(self, tmp_path):
        f = tmp_path / "test.po"
        f.write_text('msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n', encoding="utf-8")
        args = type("Args", (), {"input": str(f), "lang": "xx_XX"})()
        with patch("glot.load_valid_languages", return_value=_FAKE_LANGUAGES):
            with pytest.raises(SystemExit):
                glot.cmd_status(args)

    def test_cmd_status_skips_validation_when_no_lang(self, tmp_path):
        f = tmp_path / "test.po"
        f.write_text('msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n', encoding="utf-8")
        args = type("Args", (), {"input": str(f), "lang": None})()
        with patch("glot.load_valid_languages", return_value=_FAKE_LANGUAGES):
            glot.cmd_status(args)  # no --lang → no validation → no exit
