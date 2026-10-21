#!/usr/bin/env bash
# Store the LostFilm cookie in JacRed's private config on the Docker host and
# enable the tracker. The cookie is read without echo and sent over SSH stdin;
# it never appears in arguments, logs or this repository.
set -euo pipefail

HOST="${JACRED_HOST:?set JACRED_HOST to the Docker host SSH name}"
CONFIG="${JACRED_CONFIG:-homelab/jacred/config/init.yaml}"

read -rsp "LostFilm cookie (lf_session=...; PHPSESSID=...): " cookie
echo
[[ "$cookie" == *lf_session=* ]] || { echo "No lf_session in the cookie." >&2; exit 1; }

printf '%s' "$cookie" | ssh "$HOST" "JACRED_DRY_RUN='${JACRED_DRY_RUN:-}'; CONFIG='$CONFIG' python3 -c '
import json, os, shutil, sys, time
path = os.environ[\"CONFIG\"]
cookie = sys.stdin.read().strip()
text = open(path).read()
shutil.copy2(path, path + \".bak-lostfilm-\" + time.strftime(\"%Y%m%d%H%M%S\"))
lines = text.split(\"\\n\")
out, section = [], None
for line in lines:
    if line and not line.startswith((\" \", \"#\")):
        section = line.split(\":\")[0]
    if section == \"disable_trackers\" and line.strip() == \"- lostfilm\":
        continue
    out.append(line)
    if section == \"synctrackers\" and line.strip() == \"- lostfilm\":
        out.pop()
    if section == \"synctrackers\" and line.strip() == \"- leproduction\":
        out.append(\"  - lostfilm\")
text = \"\\n\".join(out)
block = \"Lostfilm:\\n  host: https://www.lostfilm.tv\\n  useproxy: false\\n  reqMinute: 8\\n  parseDelay: 7000\\n  log: true\\n  cookie: \" + json.dumps(cookie) + \"\\n\"
if \"\\nLostfilm:\" in text:
    # Renewing: replace only the cookie line inside the Lostfilm section.
    lines, section, replaced = text.split(\"\\n\"), None, False
    for i, line in enumerate(lines):
        if line and not line.startswith((\" \", \"#\")):
            section = line.split(\":\")[0]
        elif section == \"Lostfilm\" and line.strip().startswith(\"cookie:\"):
            lines[i] = \"  cookie: \" + json.dumps(cookie)
            replaced = True
    if not replaced:
        sys.exit(\"Lostfilm section has no cookie line; edit it by hand.\")
    text = \"\\n\".join(lines)
else:
    text = text.rstrip(\"\\n\") + \"\\n\" + block
with open(path, \"r+\") as f:
    f.seek(0); f.write(text); f.truncate()
print(\"config updated\")
' && if [ -z \"\${JACRED_DRY_RUN:-}\" ]; then docker exec jacred sh -c 'cat /app/config/init.yaml > /app/init.yaml' && echo 'JacRed reloads it within 10 s'; fi"
