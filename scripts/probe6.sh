#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Probe 6 — the server knows a settings command by a name we haven't guessed.
# That name lives in the ZFPLabServer's definitions file / FileServerCommands
# folder / the demo source. Find them on THIS machine and print the truth.
# Pure file reads + a couple of read-only confirmations. No receipt.
#
#   bash probe6.sh > result6.txt 2>&1
# ---------------------------------------------------------------------------
LOCAL="http://localhost:4444"
IP="154.79.253.236"; PORT="8000"; PW="Password"
CT='Content-Type: text/xml'; ACC='Accept: text/xml, application/xml'; T=10
line(){ printf '%s\n' "----------------------------------------------------------------------"; }

# Search roots: the repo, its parents, and common Windows/MSYS locations.
ROOTS=(
  "$(pwd)" "$(pwd)/.." "/d/Volcha" "/d" "$HOME"
  "$HOME/Desktop" "$HOME/Downloads" "$HOME/Documents"
  "/c/Users/paulc" "/c/Users/paulc/Desktop" "/c/Users/paulc/Downloads"
  "/c/Program Files" "/c/Program Files (x86)" "/c/ZFPLabServer" "/c/TSL"
)

line; echo "### 1. Find the ZFPLabServer install + its command definitions"; line
for r in "${ROOTS[@]}"; do
  [ -d "$r" ] || continue
  find "$r" -maxdepth 5 \( \
      -iname 'ZFPLabServer*' -o \
      -iname 'FileServerCommands' -o \
      -iname 'FileServerSettings.xml' -o \
      -iname 'Protocol_description*.pdf' -o \
      -iname '*.zfpdef' -o \
      -iname 'serverdef*' -o -iname 'definitions*' \
    \) 2>/dev/null
done | sort -u

line; echo "### 2. Dump FileServerCommands file names (the exact command vocabulary)"; line
FSC=""
for r in "${ROOTS[@]}"; do
  [ -d "$r" ] || continue
  d=$(find "$r" -maxdepth 6 -iname 'FileServerCommands' -type d 2>/dev/null | head -1)
  [ -n "$d" ] && FSC="$d" && break
done
echo "FileServerCommands: ${FSC:-<not found>}"
if [ -n "$FSC" ]; then
  echo "--- every command file name ---"
  find "$FSC" -maxdepth 1 -type f -printf '%f\n' 2>/dev/null | sort
  echo; echo "--- any file whose NAME hints at settings/connect/tcp ---"
  find "$FSC" -maxdepth 1 -type f \( -iname '*sett*' -o -iname '*conn*' -o -iname '*tcp*' -o -iname '*device*' \) 2>/dev/null
  echo; echo "===== VERBATIM contents of those hint files ====="
  find "$FSC" -maxdepth 1 -type f \( -iname '*sett*' -o -iname '*conn*' -o -iname '*tcp*' -o -iname '*device*' \) \
    -exec sh -c 'echo "### FILE: $1"; cat "$1"; echo' _ {} \; 2>/dev/null
fi

line; echo "### 3. Grep the definitions/demo/anything for the settings command name"; line
# The server's ServDefMissing means the name is a literal string in a def file.
# Look for the <Command Name="..."> that carries ip/port/password near it.
for r in "${ROOTS[@]}"; do
  [ -d "$r" ] || continue
  grep -rEli 'ServerSetDeviceTcp|SetDeviceTcp|<Command Name=|zfpdef|keepPortOpen|ServerSetDevice' "$r" 2>/dev/null \
    --include='*.xml' --include='*.cs' --include='*.java' --include='*.vb' --include='*.txt' --include='*.js' --include='*.ts' \
    | grep -viE 'node_modules|/\.git/' | head -20
done | sort -u > /tmp/_hits.txt
cat /tmp/_hits.txt
echo; echo "--- lines mentioning a settings/connect command + its args (first hits) ---"
while read -r f; do
  [ -f "$f" ] || continue
  echo "### $f"
  grep -nEi 'Command Name="[^"]*[Ss]et[^"]*"|Command Name="[^"]*[Cc]onn[^"]*"|ServerSetDeviceTcp|keepPortOpen|<ip>|SetDeviceTcpSettings' "$f" 2>/dev/null | head -8
done < /tmp/_hits.txt

line; echo "### 4. Does the app repo itself already encode a working command list?"; line
# Your own repo's provider/xml-utils may reveal what a prior dev confirmed.
grep -rniE 'Command Name=|Request Name=|localhost:4444|ServerSetDevice|settings\(\)|FileServerCommands' \
  "$(pwd)/src" 2>/dev/null | grep -viE 'node_modules' | head -20

line; echo "### 5. Sanity: server still up + still asking for settings"; line
curl -sS -m "$T" -w '\n[HTTP %{http_code}]\n' -H "$CT" -H "$ACC" -X POST "$LOCAL" \
  --data '<Command Name="ReadStatus"></Command>' 2>&1

line; echo "WHAT I NEED FROM THIS:"; line
echo "  * Section 2/3: the literal command file / def line for settings gives the"
echo "    EXACT Name= string. That string inside <Command Name=\"THAT\"> + its args = done."
echo "  * If Section 1 finds Protocol_description_*.pdf, open it to the Settings/"
echo "    ServerSetDeviceTcpSettings page and read the zfpdef name + arg list."
echo "  * If NOTHING is found on disk, the API Files folder isn't on this machine —"
echo "    tell me and I'll get the name a different way."