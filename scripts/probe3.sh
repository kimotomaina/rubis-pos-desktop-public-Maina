#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Probe 3 — nail the exact SETTINGS command the local ZFPLabServer (:4444)
# accepts. The server already told us (Code 53) that a settings command
# exists and must run first; we just have the name/arg shape slightly off.
# Read-only. No receipt. Once a variant returns Code="0", we immediately
# run ReadStatus in the SAME connection state to confirm the device answers.
#
# Run on the till.  bash probe3.sh > result3.txt 2>&1
# ---------------------------------------------------------------------------

LOCAL="http://localhost:4444"
IP="154.79.253.236"; PORT="8000"; PW="Password"
CT='Content-Type: text/xml'; ACC='Accept: text/xml, application/xml'; T=10

line(){ printf '%s\n' "----------------------------------------------------------------------"; }
try(){  # try <label> <body>
  printf '\n>>> %s\n' "$1"; printf 'BODY %s\n' "$2"
  local out
  out=$(curl -sS -m "$T" -w '\n[HTTP %{http_code}]' -H "$CT" -H "$ACC" -X POST "$LOCAL" --data "$2" 2>&1)
  printf '%s\n' "$out"
  # If this settings variant succeeded, immediately probe ReadStatus to prove the chain.
  if printf '%s' "$out" | grep -q 'Code="0"'; then
    printf '    >>> Code 0! Following up with ReadStatus in this session:\n'
    curl -sS -m "$T" -w '\n[HTTP %{http_code}]\n' -H "$CT" -H "$ACC" -X POST "$LOCAL" \
      --data '<Request Name="ReadStatus"></Request>' 2>&1
  fi
}

line; echo "### Finding the exact SETTINGS command name + arg shape on :4444"; line
echo "Server already confirmed (Code 53) a settings command exists. Converging on its name."

# --- Name variations, child-tag argument style -----------------------------
try "1. Name=settings (lowercase), child tags" \
"<Request Name=\"settings\"><com></com><baud></baud><tcp>1</tcp><ip>${IP}</ip><port>${PORT}</port><password>${PW}</password></Request>"

try "2. Name=Settings (capital), full arg set incl com/baud/keepPortOpen" \
"<Request Name=\"Settings\"><com></com><baud></baud><keepPortOpen>1</keepPortOpen><tcp>1</tcp><ip>${IP}</ip><port>${PORT}</port><password>${PW}</password></Request>"

# --- Attribute argument style (args as XML attributes, not child tags) ------
try "3. Name=Settings, args as attributes on the Request element" \
"<Request Name=\"Settings\" com=\"\" baud=\"\" tcp=\"1\" ip=\"${IP}\" port=\"${PORT}\" password=\"${PW}\"></Request>"

try "4. Name=settings (lowercase), args as attributes" \
"<Request Name=\"settings\" com=\"\" baud=\"\" tcp=\"1\" ip=\"${IP}\" port=\"${PORT}\" password=\"${PW}\"></Request>"

# --- Args nested under a <settings> element (mirrors the Res echo shape) ----
try "5. Name=Settings with nested <settings> block (mirrors response echo)" \
"<Request Name=\"Settings\"><settings><com></com><baud></baud><tcp>1</tcp><ip>${IP}</ip><port>${PORT}</port><password>${PW}</password></settings></Request>"

# --- The literal demo string as the element text ---------------------------
try "6. Name=Settings, demo-string as text content" \
"<Request Name=\"Settings\">com=,baud=,tcp=1,ip=${IP},port=${PORT},password=${PW}</Request>"

# --- ServerSetDeviceTcpSettings (the actual API method name from the manual) 
try "7. Name=ServerSetDeviceTcpSettings (SDK method name), child tags" \
"<Request Name=\"ServerSetDeviceTcpSettings\"><ip>${IP}</ip><port>${PORT}</port><password>${PW}</password></Request>"

try "8. Name=ServerSetDeviceTCP_Settings variant" \
"<Request Name=\"ServerSetDeviceTCP_Settings\"><ip>${IP}</ip><port>${PORT}</port><password>${PW}</password></Request>"

line
echo "### Reading list of what the server DOES know (in case one of these self-documents)"
line
# Some ZFPLabServer builds answer a definitions/help query. Harmless to try.
for name in Help Commands Definitions ListCommands GetDefinitions ServerInfo Version; do
  printf '\n>>> Name=%s\n' "$name"
  curl -sS -m "$T" -w '\n[HTTP %{http_code}]\n' -H "$CT" -H "$ACC" -X POST "$LOCAL" \
    --data "<Request Name=\"${name}\"></Request>" 2>&1 | head -20
done

line
echo "READ THE RESULTS:"
echo "  * The variant that returns <Res Code=\"0\"> is the correct settings command."
echo "    Its ReadStatus follow-up (auto-run) then shows CU_fiscalized / Paired_with_TIMS."
echo "  * Code 10 ServDefMissing  -> wrong NAME, ignore that variant."
echo "  * Code 53 ClientSettings  -> right idea, but that specific call didn't set params."
echo "  * Any other Code<>0 with an <Err> -> reached device logic; note the code."