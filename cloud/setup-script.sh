#!/bin/bash
# Setup script for the "Discord coach" cloud environment (claude.ai/code → environment → Setup script).
# Installs the `discord-post` helper the coach task uses to post in Discord, and matplotlib for charts.
# Generated from cloud/discord-post by `npm run setup-script`: edit that file, not this one.
set -e
cat > /usr/local/bin/discord-post <<'DISCORD_POST_EOF'
#!/usr/bin/env python3
"""Post a message to the Discord channel webhook in $DISCORD_WEBHOOK_URL.

Usage:  discord-post reply.md        (or:  echo "text" | discord-post)
        discord-post --confirm reply.md   (a calendar proposal: adds Confirm / Cancel buttons)
        discord-post --file chart.png reply.md   (attach a file; repeatable, the text is still required)

Splits long text into Discord-sized parts (max 2000 chars each), retries on
rate limits, and exits non-zero if posting fails. Buttons need the app-owned
webhook (README); with another webhook the text is posted without them.
Buttons and files go under the last part.
"""
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

LIMIT = 1900
MAX_FILES = 10
MAX_FILE_BYTES = 10 * 1024 * 1024  # Discord's upload limit on an unboosted server
USERNAME = "Coach"
# Same custom_ids as src/proposal.ts in the Worker.
CONFIRM_BUTTONS = [
    {
        "type": 1,
        "components": [
            {"type": 2, "style": 3, "label": "✅ Confirm", "custom_id": "proposal:confirm"},
            {"type": 2, "style": 2, "label": "Cancel", "custom_id": "proposal:cancel"},
        ],
    }
]


def split_message(text, limit=LIMIT):
    """Split on paragraph, then line, then hard boundaries."""
    text = text.strip()
    parts = []
    while len(text) > limit:
        cut = text.rfind("\n\n", 0, limit)
        if cut < limit // 2:
            cut = text.rfind("\n", 0, limit)
        if cut < limit // 2:
            cut = text.rfind(" ", 0, limit)
        if cut <= 0:
            cut = limit
        parts.append(text[:cut].rstrip())
        text = text[cut:].lstrip()
    if text:
        parts.append(text)
    return parts


def read_files(paths):
    """[(name, content type, bytes)]. Exits before anything is posted if a file can't be used."""
    if len(paths) > MAX_FILES:
        raise SystemExit(f"discord-post: at most {MAX_FILES} files per message")
    files = []
    for path in paths:
        try:
            with open(path, "rb") as fh:
                data = fh.read()
        except OSError as err:
            raise SystemExit(f"discord-post: cannot read {path}: {err}")
        if not data:
            raise SystemExit(f"discord-post: {path} is empty")
        if len(data) > MAX_FILE_BYTES:
            raise SystemExit(f"discord-post: {path} is over 10 MB")
        name = os.path.basename(path).replace('"', "")
        files.append((name, mimetypes.guess_type(name)[0] or "application/octet-stream", data))
    return files


def multipart(payload, files):
    """(body, content type) of a webhook message with attachments."""
    boundary = uuid.uuid4().hex
    chunks = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\n'
        "Content-Type: application/json\r\n\r\n".encode(),
        json.dumps(payload).encode(),
        b"\r\n",
    ]
    for i, (name, content_type, data) in enumerate(files):
        chunks += [
            f'--{boundary}\r\nContent-Disposition: form-data; name="files[{i}]"; filename="{name}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n".encode(),
            data,
            b"\r\n",
        ]
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


def post(url, content, components=None, files=None, attempts=4):
    payload = {"content": content, "username": USERNAME, "allowed_mentions": {"parse": []}}
    if components:
        payload["components"] = components
    if files:
        body, content_type = multipart(payload, files)
    else:
        body, content_type = json.dumps(payload).encode(), "application/json"
    sep = "&" if "?" in url else "?"
    for attempt in range(attempts):
        req = urllib.request.Request(
            f"{url}{sep}wait=true&with_components=true",
            data=body,
            headers={"Content-Type": content_type, "User-Agent": "discord-coach/1.0"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                return res.status
        except urllib.error.HTTPError as err:
            if err.code == 429 and attempt < attempts - 1:
                try:
                    wait = float(json.loads(err.read() or b"{}").get("retry_after", 1))
                except ValueError:
                    wait = 1.0
                time.sleep(min(max(wait, 0.5), 30))
                continue
            detail = err.read().decode(errors="replace")[:300]
            if err.code == 400 and components:
                # Not the app-owned webhook: buttons aren't allowed. Post the text alone.
                print(f"discord-post: buttons rejected ({detail}); posting without them", file=sys.stderr)
                return post(url, content, None, files, attempts)
            raise SystemExit(f"discord-post: HTTP {err.code} from Discord: {detail}")
        except urllib.error.URLError as err:
            if attempt < attempts - 1:
                time.sleep(2)
                continue
            raise SystemExit(
                f"discord-post: cannot reach Discord ({err.reason}). "
                "Is discord.com in the cloud environment's allowed domains?"
            )
    raise SystemExit("discord-post: gave up after retries")


def main():
    url = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()
    if not url:
        raise SystemExit(
            "discord-post: DISCORD_WEBHOOK_URL is not set in this cloud environment."
        )
    args = sys.argv[1:]
    confirm = "--confirm" in args
    args = [a for a in args if a != "--confirm"]
    paths = []
    while "--file" in args:
        i = args.index("--file")
        if i + 1 >= len(args):
            raise SystemExit("discord-post: --file needs a path")
        paths.append(args[i + 1])
        del args[i : i + 2]
    files = read_files(paths)
    if args and args[0] != "-":
        with open(args[0], encoding="utf-8") as fh:
            text = fh.read()
    else:
        text = sys.stdin.read()
    parts = split_message(text)
    if not parts:
        raise SystemExit("discord-post: nothing to send")
    for i, part in enumerate(parts):
        last = i == len(parts) - 1
        post(url, part, CONFIRM_BUTTONS if confirm and last else None, files if last else None)
        if not last:
            time.sleep(0.6)
    extras = (" with Confirm / Cancel buttons" if confirm else "") + (f" with {len(files)} file(s)" if files else "")
    print(f"discord-post: sent {len(parts)} message(s){extras}")


if __name__ == "__main__":
    main()
DISCORD_POST_EOF
chmod +x /usr/local/bin/discord-post
echo "discord-post installed"
# Charts are optional: a failed install must not stop the coach.
python3 -m pip install --quiet matplotlib || python3 -m pip install --quiet --break-system-packages matplotlib || echo "matplotlib not installed"
