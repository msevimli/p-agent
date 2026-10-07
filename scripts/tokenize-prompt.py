#!/usr/bin/env python3
"""Tokenize prompt JSON dumps (from scripts/measure-prompts.js) with the real
Qwen2 tokenizer and print token counts, raw and through a simulated
llama.cpp-style Qwen chat template (tools rendered as a second system
message, as llama.cpp's tool-supporting chat template does).

Usage: python3 scripts/tokenize-prompt.py <dump.json> [--qwen /tmp/qwen-tokenizer.json]
"""
import json
import sys

from tokenizers import Tokenizer


def main() -> int:
    prompt_file = sys.argv[1] if len(sys.argv) > 1 else "/tmp/new-prompt.json"
    tok_path = "/tmp/qwen-tokenizer.json"
    for i, a in enumerate(sys.argv):
        if a == "--qwen" and i + 1 < len(sys.argv):
            tok_path = sys.argv[i + 1]

    tok = Tokenizer.from_file(tok_path)
    data = json.load(open(prompt_file, encoding="utf-8"))

    def count(s: str) -> int:
        return len(tok.encode(s).ids)

    system = data.get("systemText", "")
    user = data.get("sampleUserMessage", "")

    # llama.cpp Qwen tool template (approximation of common_chat_templates):
    # BOS + [system msg][tools as second system msg][user msg][assistant open].
    def qwen_template(sys_text: str, tools_json: str, user_text: str) -> str:
        out = "<|im_start|>system\n" + sys_text + "<|im_end|>\n"
        if tools_json:
            out += (
                "<|im_start|>system\n# Tools\n\n"
                "You may call one or more functions without altering your content. "
                "You have access to the following functions:\n"
                + tools_json
                + "\n<|im_end|>\n"
            )
        out += "<|im_start|>user\n" + user_text + "<|im_end|>\n"
        out += "<|im_start|>assistant\n"
        return out

    print("RAW text counts (system + tools JSON as sent in the payload):")
    print(f"  system text tokens            : {count(system)}")

    if "toolsText" in data or "toolsJson" in data:  # old dump shape
        tools = data.get("toolsText", data.get("toolsJson", ""))
        print(f"  tools JSON tokens             : {count(tools)}")
        prefix = count(system + tools)
        print(f"  system+tools (prefix)         : {prefix}")
        tpl = qwen_template(system, tools, user)
        print(f"  Qwen chat-template full prompt: {count(tpl)}")
        if data.get("prefixHash"):
            print(f"  prefix hash                   : {data['prefixHash']}")
    else:
        core = data.get("coreToolsJson", "[]")
        allt = data.get("allToolsJson", "[]")
        print(f"  core tools JSON tokens        : {count(core)} ({data.get('coreToolsCount')} tools)")
        print(f"  all-topic tools JSON tokens   : {count(allt)} ({data.get('allToolsCount')} tools)")
        print(f"  prefix (system + core tools)  : {count(system + core)}")
        print(f"  prefix (system + all tools)   : {count(system + allt)}")
        tpl_core = qwen_template(system, core, user)
        tpl_all = qwen_template(system, allt, user)
        print(f"  Qwen template, core tools     : {count(tpl_core)}")
        print(f"  Qwen template, all tools      : {count(tpl_all)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())