#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Probe 4 — stop guessing the envelope. Read the TRUTH from the ZFPLabServer's
# own FileServerCommands folder and the demo source, then test the exact shape.
# Also tests whether :4444 routes by URL PATH instead of the body Name=.
# Read-only. No receipt.
#
# EDIT the two paths below to point at your API Files folder, then:
#   bash probe4.sh > result4.txt 2>&1
# ---------------------------------------------------------------------------

# --- POINT THESE AT YOUR API FILES FOLDER ----------------------------------
# The folder TSL gave you. Adjust to wherever it lives on this machine.
API_FILES="${1:-$HOME/API Files}"

LOCAL="http://localhost:4444"
IP="154.79.253.236"; PORT="8000"; PW="Password"
CT='Content-Type: text/xml'; ACC='Accept: text/xml, application/xml'; T=10
line(){ printf '%s\n' "----------------------------------------------------------------------"; }

line; echo "### 0. Locate the SDK files (FileServerCommands + demos)"; line
echo "Looking under: $API_FILES"
if [ ! -d "$API_FILES" ]; then
  echo "!! Folder not found. Re-run as:  bash probe4.sh \"/full/path/to/API Files\""
  echo "   Searching common spots instead..."
  for guess in "$HOME/Desktop" "$HOME/Downloads" "$HOME/Documents" "/opt" "C:/"; do
    [ -d "$guess" ] && find "$guess" -maxdepth 4 -iname 'FileServerCommands' -type d 2>/dev/null
  done
fi

# --- Dump the real settings + read-status command files verbatim ------------
line; echo "### 1. The server's OWN command files (this is the exact envelope)"; line
FSC=$(find "$API_FILES" -iname 'FileServerCommands' -type d 2>/dev/null | head -1)
echo "FileServerCommands dir: ${FSC:-<not found>}"
if [ -n "$FSC" ]; then
  echo; echo "--- files mentioning 'settings' ---"
  find "$FSC" -iname '*setting*' 2>/dev/null
  echo; echo "--- files mentioning 'status' ---"
  find "$FSC" -iname '*status*' 2>/dev/null
  echo; echo "===== VERBATIM: any settings command file ====="
  find "$FSC" -iname '*setting*' -exec sh -c 'echo "### $1"; cat "$1"; echo' _ {} \; 2>/dev/null | head -80
  echo; echo "===== VERBATIM: any ReadStatus command file ====="
  find "$FSC" -iname '*status*' -exec sh -c 'echo "### $1"; cat "$1"; echo' _ {} \; 2>/dev/null | head -60
  echo; echo "--- ALL command file names (the full command vocabulary) ---"
  find "$FSC" -maxdepth 1 -type f -printf '%f\n' 2>/dev/null | sort
fi

# --- Pull the on-the-wire format out of the demo source ---------------------
line; echo "### 2. How the DEMO source actually sends Settings + ReadStatus"; line
echo "--- grep for the request envelope / command dispatch in demo code ---"
grep -rEni 'Request Name|<Command|ServerSetDeviceTcp|SetDeviceTcp|ReadStatus|clientID|client_id|localhost:4444' \
  "$API_FILES" --include='*.cs' --include='*.java' --include='*.vb' --include='*.xml' --include='*.txt' 2>/dev/null \
  | grep -viE 'using |import |^\s*//|^\s*\*' | head -60

# --- Test 1: does the server route by URL PATH, not body Name=? -------------
line; echo "### 3. TEST — does :4444 dispatch on the URL PATH instead of Name=?"; line
for cmd in ReadStatus ReadDateTime Version; do
  printf '\n>>> POST %s/%s (empty body)\n' "$LOCAL" "$cmd"
  curl -sS -m "$T" -w '\n[HTTP %{http_code}]\n' -H "$CT" -H "$ACC" -X POST "$LOCAL/$cmd" --data '' 2>&1 | head -12
done

# --- Test 2: does it need a clientID / session wrapper? ---------------------
line; echo "### 4. TEST — root <Command> element instead of <Request Name=>"; line
printf '>>> <Command Name="ReadStatus">\n'
curl -sS -m "$T" -w '\n[HTTP %{http_code}]\n' -H "$CT" -H "$ACC" -X POST "$LOCAL" \
  --data '<Command Name="ReadStatus"></Command>' 2>&1 | head -12
printf '\n>>> root element IS the command: <ReadStatus/>\n'
curl -sS -m "$T" -w '\n[HTTP %{http_code}]\n' -H "$CT" -H "$ACC" -X POST "$LOCAL" \
  --data '<ReadStatus></ReadStatus>' 2>&1 | head -12
printf '\n>>> with a clientID wrapper (Localhost, per the Res echo in the manual)\n'
curl -sS -m "$T" -w '\n[HTTP %{http_code}]\n' -H "$CT" -H "$ACC" -X POST "$LOCAL" \
  --data '<Request Name="ReadStatus" clientID="Localhost"></Request>' 2>&1 | head -12

line; echo "READ THE RESULTS:"; line
echo "  * Section 1/2 give the EXACT command name + envelope from the vendor's own files."
echo "    Whatever the settings file is literally called + its XML body = what to send."
echo "  * Section 3: if POST /ReadStatus returns Code 0 or Code 53, the server routes by"
echo "    URL PATH, and our whole 'Name= in the body' approach was the bug."
echo "  * Section 4: if <ReadStatus/> or the clientID form flips Code 10 -> Code 53,"
echo "    that's the envelope. Code 53 here = SUCCESS (means 'now send settings first')."