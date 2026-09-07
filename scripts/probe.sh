#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Tremol G03 / TSL read-only validation probe.
# Confirms the app -> server -> Control Unit chain works WITHOUT opening
# any receipt. No OpenInvoice, no SellPLU, no CloseReceipt. Safe to re-run.
#
# Run this ON THE TILL MACHINE (the one on the same LAN as the device).
# Usage:  bash probe.sh
# ---------------------------------------------------------------------------

# --- Config (edit only if these change) ------------------------------------
BASE_URL="http://154.79.253.241:8080/TSL/kra"   # the TSL service URL you were given
DEVICE_IP="154.79.253.236"                       # Control Unit IP
DEVICE_PORT="8000"                               # Control Unit port
PASSWORD="Password"                              # device TCP password

# Common local ZFPLabServer address, per the VIL manual (http://localhost:4444).
# The probe tries the TSL URL first, then falls back to this if that fails.
LOCAL_URL="http://localhost:4444"

CT='Content-Type: text/xml'
ACC='Accept: text/xml, application/xml'
TIMEOUT=10

line(){ printf '%s\n' "----------------------------------------------------------------------"; }
hdr(){ line; printf '### %s\n' "$1"; line; }

# post <url> <xml-body> [querystring]
post(){
  local url="$1" body="$2" qs="$3"
  local full="$url"
  [ -n "$qs" ] && full="${url}?${qs}"
  printf 'POST %s\n' "$full"
  printf 'BODY %s\n\n' "$body"
  curl -sS -m "$TIMEOUT" -w '\n[HTTP %{http_code}, %{time_total}s]\n' \
       -H "$CT" -H "$ACC" -X POST "$full" --data "$body" 2>&1
  echo
}

# ---------------------------------------------------------------------------
hdr "0. Is anything listening at the TSL URL?"
curl -sS -m "$TIMEOUT" -o /dev/null -w 'TSL base  %{url}  ->  HTTP %{http_code}  (%{time_total}s)\n' \
     "$BASE_URL" 2>&1 || echo "TSL base   -> NO RESPONSE (connection refused / timed out / DNS)"
curl -sS -m "$TIMEOUT" -o /dev/null -w 'Local 4444 %{url}  ->  HTTP %{http_code}  (%{time_total}s)\n' \
     "$LOCAL_URL" 2>&1 || echo "Local 4444 -> NO RESPONSE"
echo
echo "Can this machine even reach the Control Unit's TCP port? (needs nc; skip if absent)"
if command -v nc >/dev/null 2>&1; then
  if nc -z -w 5 "$DEVICE_IP" "$DEVICE_PORT" 2>/dev/null; then
    echo "  Device $DEVICE_IP:$DEVICE_PORT  ->  OPEN"
  else
    echo "  Device $DEVICE_IP:$DEVICE_PORT  ->  UNREACHABLE (this alone will break everything downstream)"
  fi
else
  echo "  (nc not installed — skipping raw TCP check)"
fi
echo

# ---------------------------------------------------------------------------
# STEP 2 in the manual: SETTINGS. This is the real "connect to the device"
# call. A <Res Code="0"> that echoes your ip/port back = the server reached
# the Control Unit. This is the single most useful test and opens nothing.
#
# The manual's file-command/HTTP form for Settings is not 100% pinned down,
# so we try the documented parameter styles in turn and let the responses
# tell us which the server accepts. Whichever returns Code="0" is the answer.
# ---------------------------------------------------------------------------
hdr "1. SETTINGS  (establish connection to the Control Unit — no receipt)"

echo ">>> 1a. XML body with settings child tags"
post "$BASE_URL" \
"<Request Name=\"Settings\"><tcp>1</tcp><ip>${DEVICE_IP}</ip><port>${DEVICE_PORT}</port><password>${PASSWORD}</password></Request>"

echo ">>> 1b. XML body with attribute-style settings string (mirrors the demo UI)"
post "$BASE_URL" \
"<Request Name=\"Settings\">com=,baud=,tcp=1,ip=${DEVICE_IP},port=${DEVICE_PORT},password=${PASSWORD}</Request>"

echo ">>> 1c. Device coords as query params, empty Settings body"
post "$BASE_URL" \
"<Request Name=\"Settings\"></Request>" \
"tcp=1&ip=${DEVICE_IP}&port=${DEVICE_PORT}&password=${PASSWORD}"

# ---------------------------------------------------------------------------
# STEP 3 in the manual: READ STATUS. Read-only. Returns the 6-byte CU status
# incl. CU_fiscalized and Paired_with_TIMS. This is your health check.
# We send it three ways so at least one lands regardless of how the server
# expects the device coords carried.
# ---------------------------------------------------------------------------
hdr "2. READ STATUS  (device health — CU_fiscalized / Paired_with_TIMS)"

echo ">>> 2a. plain body"
post "$BASE_URL" "<Request Name=\"ReadStatus\"></Request>"

echo ">>> 2b. device coords as query params"
post "$BASE_URL" "<Request Name=\"ReadStatus\"></Request>" \
"ip=${DEVICE_IP}&port=${DEVICE_PORT}&password=${PASSWORD}"

echo ">>> 2c. device coords as headers"
printf 'POST %s (with X-Device-* headers)\n\n' "$BASE_URL"
curl -sS -m "$TIMEOUT" -w '\n[HTTP %{http_code}, %{time_total}s]\n' \
     -H "$CT" -H "$ACC" \
     -H "X-Device-IP: ${DEVICE_IP}" -H "X-Device-Port: ${DEVICE_PORT}" -H "X-ZFP-Password: ${PASSWORD}" \
     -X POST "$BASE_URL" --data "<Request Name=\"ReadStatus\"></Request>" 2>&1
echo

# ---------------------------------------------------------------------------
# Two more harmless reads. Both are pure queries — no receipt state touched.
# ReadVATrates confirms the KRA VAT table (A=16, B=8, C=0...) is loaded.
# ReadDateTime confirms the device clock (a wrong clock blocks fiscalization).
# ---------------------------------------------------------------------------
hdr "3. READ VAT RATES  (confirms A/B/C/D/E tax table is loaded)"
post "$BASE_URL" "<Request Name=\"ReadVATrates\"></Request>"

hdr "4. READ DATE & TIME  (confirms device clock is set)"
post "$BASE_URL" "<Request Name=\"ReadDateTime\"></Request>"

hdr "DONE"
echo "How to read the output:"
echo "  * Any <Res Code=\"0\" ...>            -> that command SUCCEEDED."
echo "  * Settings echoing your ip/port back  -> app<->server<->device chain is UP."
echo "  * ReadStatus CU_fiscalized Value=1    -> device is fiscalized."
echo "  * ReadStatus Paired_with_TIMS Value=1 -> device is paired with KRA TIMS."
echo "  * HTTP 404 / Tomcat page              -> wrong URL or method."
echo "  * HTTP 500 / NullPointer              -> reached the server, wrong/absent Settings."
echo "  * Res Code=\"...\" non-zero            -> reached the device; note the code + STE2."
echo "  * NO RESPONSE at step 0               -> network/firewall to the server, fix that first."