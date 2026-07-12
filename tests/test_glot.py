import pytest
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
