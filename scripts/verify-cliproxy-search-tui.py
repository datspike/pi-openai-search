#!/usr/bin/env python3
"""Живая приёмка через PTY: Terra, настоящий transport, /reload, JSONL и видимая карточка.

Требует настроенного локального CLIProxyAPI. Делает три запроса к модели.
Учётные данные копируются во временный закрытый каталог и удаляются после выхода.
В каталоге результата остаются только тестовая сессия, поисковые события и квитанция.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--provider-extension", type=Path, required=True)
parser.add_argument("--model", default="cliproxyapi/gpt-5.6-terra")
parser.add_argument("--tui-mode", choices=["regular", "fullscreen"], default="regular")
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--timeout", type=int, default=180)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
provider = args.provider_extension.resolve()
result_dir = args.output.resolve()
result_dir.mkdir(parents=True, exist_ok=False)
session = result_dir / "session.jsonl"
raw = result_dir / "search-events.jsonl"
pi = shutil.which("pi")
assert pi, "pi executable is required"
agent_dir = Path(os.environ.get("PI_CODING_AGENT_DIR", Path.home() / ".pi/agent"))
ansi = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
transcript = bytearray()


def entries():
    if not session.exists():
        return []
    rows = []
    for line in session.read_text().splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            pass  # Последняя строка может ещё записываться.
    return rows


def assistants():
    return [row["message"] for row in entries() if row.get("message", {}).get("role") == "assistant"]


def cards():
    return [row for row in entries() if row.get("customType") == "openai-native-search-results"]


def plain():
    return ansi.sub("", transcript.decode(errors="replace"))


with tempfile.TemporaryDirectory(prefix="pi-native-search-live-") as temp:
    temp = Path(temp)
    for name in ["cliproxyapi.json", "cliproxyapi-models.json"]:
        source = agent_dir / name
        if source.exists():
            shutil.copyfile(source, temp / name)
            (temp / name).chmod(0o600)
    auth = json.loads((agent_dir / "auth.json").read_text())
    (temp / "auth.json").write_text(json.dumps({k: v for k, v in auth.items() if k == "cliproxyapi"}))
    (temp / "auth.json").chmod(0o600)
    audit = temp / "audit.mjs"
    audit.write_text('''import { appendFileSync } from "node:fs";
export default function(pi) {
  const off = pi.events.on("cliproxyapi:responses-event", ({ event, model }) => {
    const items = event.response?.output || [event.item];
    const calls = items.filter(item => item?.type === "web_search_call");
    if (calls.length) appendFileSync(process.env.SEARCH_PROOF_RAW, JSON.stringify({
      type: event.type, provider: model.provider, model: model.id, api: model.api, calls
    }) + "\\n");
  });
  pi.on("session_shutdown", () => off());
}
''')
    env = {**os.environ, "PI_CODING_AGENT_DIR": str(temp), "TERM": "xterm-256color",
           "PI_OPENAI_NATIVE_SEARCH": "true", "PI_OPENAI_NATIVE_SEARCH_MODE": "live",
           "PI_OPENAI_NATIVE_SEARCH_INTERACTIVE_COMPAT": "false",
           "PI_OPENAI_NATIVE_SEARCH_TOOL_RENDER_COMPAT": "false", "SEARCH_PROOF_RAW": str(raw)}
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 140, 0, 0))
    command = [pi, "--no-extensions", "-e", str(provider), "-e", str(root / "index.js"), "-e", str(audit),
               "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
               "--no-tools", "--model", args.model, "--thinking", "low", "--tui-mode", args.tui_mode,
               "--session", str(session)]
    process = subprocess.Popen(command, cwd=temp, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)

    def wait_for(condition, description):
        deadline = time.monotonic() + args.timeout
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.15)[0]:
                try:
                    transcript.extend(os.read(master, 65536))
                except OSError:
                    break
            if condition():
                return
            if process.poll() is not None:
                break
        raise AssertionError(f"Timed out: {description}; see terminal.txt")

    try:
        wait_for(lambda: "[Extensions]" in plain() and "(cliproxyapi)" in plain(), "initialized TUI")
        os.write(master, "Ответь ровно CONTROL_OK. Не используй поиск и инструменты.\r".encode())
        wait_for(lambda: len(assistants()) == 1 and any(b.get("text", "").strip() == "CONTROL_OK" for b in assistants()[0]["content"]), "negative response")
        assert not cards(), "No-search response produced a card"
        assert not raw.exists(), "Negative response unexpectedly performed search"
        start_reload = len(transcript)
        os.write(master, b"/reload\r")
        wait_for(lambda: re.search(r"reload(?:ed|ing complete)|resources reloaded", plain()[len(ansi.sub('', transcript[:start_reload].decode(errors='replace'))):], re.I), "reload confirmation")
        os.write(master, "Используй web_search: найди на python.org последний стабильный выпуск Python. Ответь одним предложением с номером версии и ссылкой на источник.\r".encode())
        wait_for(lambda: len(assistants()) >= 2 and cards() and "Searched" in plain(), "real search card after reload")
        messages = assistants()
        assert all(m["provider"] == "cliproxyapi" and m["api"] == "cliproxyapi-codex-responses"
                   and m["model"] == args.model.split("/", 1)[1] for m in messages)
        assert all(m["stopReason"] not in ["error", "aborted"] for m in messages)
        observed = [json.loads(line) for line in raw.read_text().splitlines()]
        call_ids = {call["id"] for record in observed for call in record["calls"]}
        displayed = [search for card in cards() for search in card["data"]["searches"]]
        assert displayed and all(search["id"] in call_ids for search in displayed)
        assert len(cards()) == 1, "Duplicate cards after reload"
        for search in displayed:
            assert search["label"] in plain(), "Persisted card was not visible in TUI"
        assert "UI compat" not in plain()
        rendered_terminal = transcript.decode(errors="replace")
        marker = "⌕ Web search"
        marker_index = rendered_terminal.rfind(marker)
        assert marker_index >= 0 and re.search(r"\x1b\[(?:\d+;)*4\d", rendered_terminal[max(0, marker_index - 80):marker_index]), "Card header has no background style"
        # Повторная загрузка должна восстановить карточку из истории, а не создать ещё одну.
        replay_start = len(transcript)
        os.write(master, b"/reload\r")
        wait_for(lambda: all(s["label"] in ansi.sub("", transcript[replay_start:].decode(errors="replace")) for s in displayed)
                 and re.search(r"reloaded", ansi.sub("", transcript[replay_start:].decode(errors="replace")), re.I), "card replay after reload")
        # Перерисовка истории завершается раньше, чем новый input гарантированно принимается.
        time.sleep(1)
        os.write(master, "Теперь ответь ровно CONTROL_AGAIN, без поиска и инструментов.\r".encode())
        wait_for(lambda: len(assistants()) == 3 and any(b.get("text", "").strip() == "CONTROL_AGAIN" for b in assistants()[-1]["content"]), "normal follow-up after search")
        assert len(cards()) == 1, "No-search continuation added another card"
        assert len(raw.read_text().splitlines()) == len(observed), "Follow-up unexpectedly performed search"
        assert assistants()[-1]["model"] == args.model.split("/", 1)[1]
        all_entries = entries()
        assert all_entries.index(cards()[0]) > next(i for i, r in enumerate(all_entries) if r.get("message") == messages[1])
        receipt = {"status": "passed", "model": args.model, "api": "cliproxyapi-codex-responses",
                   "tui_mode": args.tui_mode, "reloaded": True, "negative_cards": 0,
                   "replayed_after_reload": True, "normal_followup": True,
                   "card_background": True,
                   "cards": len(cards()), "observed_search_ids": sorted(call_ids),
                   "rendered_search_ids": [s["id"] for s in displayed],
                   "sources_visible": any("https://" in s["output"] and "https://" in plain() for s in displayed),
                   "source_hashes": {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [
                       root / "index.js", root / "src/compat/provider/cliproxy-search-events.js",
                       provider / "extensions/index.ts", provider / "extensions/codex-stream.ts"]}}
        (result_dir / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        print(json.dumps(receipt, indent=2))
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        os.close(master)
        (result_dir / "terminal.txt").write_text(plain())
