#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Probe 2 — figure out WHICH server drives the device, and what the
# :241 webapp actually is. Still read-only: Settings + ReadStatus only,
# no receipt is opened anywhere.
#
# Run on the till machine.  bash probe2.sh > result2.txt 2>&1
# ---------------------------------------------------------------------------

DEVICE_IP="154.79.253.236"
DEVICE_PORT="8000"
PASSWORD="Password"

LOCAL="http://localhost:4444"                        # the ZFPLabServer that returned 200
REMOTE="http://154.79.253.241:8080/TSL/kra"          # the Tomcat webapp that 500s
REMOTE_ROOT="http://154.79.253.241:8080/"            # its host root
REMOTE_APP="http://154.79.253.241:8080/TSL/"         # the webapp root

CT='Content-Type: text/xml'
ACC='Accept: text/xml, application/xml'
T=10
line(){ printf '%s\n' "----------------------------------------------------------------------"; }
hdr(){ line; printf '### %s\n' "$1"; line; }
post(){ printf 'POST %s\nBODY %s\n\n' "$1" "$2"
  curl -sS -m "$T" -w '\n[HTTP %{http_code}, %{time_total}s]\n' -H "$CT" -H "$ACC" -X POST "$1" --data "$2" 2>&1; echo; }
get(){ printf 'GET %s\n' "$1"
  curl -sS -m "$T" -w '\n[HTTP %{http_code}]\n' "$1" 2>&1 | head -40; echo; }

# ===========================================================================
hdr "A. Does the LOCAL ZFPLabServer (:4444) drive the device? (the real test)"
# Per the VIL manual this is THE server that speaks to the CU. If Settings +
# ReadStatus return Code=0 here, your device works and the app just needs to
# point at :4444, not :241.

echo ">>> A1. Settings via local server"
post "$LOCAL" "<Request Name=\"Settings\"><tcp>1</tcp><ip>${DEVICE_IP}</ip><port>${DEVICE_PORT}</port><password>${PASSWORD}</password></Request>"

echo ">>> A2. ReadStatus via local server"
post "$LOCAL" "<Request Name=\"ReadStatus\"></Request>"

echo ">>> A3. ReadDateTime via local server"
post "$LOCAL" "<Request Name=\"ReadDateTime\"></Request>"

# ===========================================================================
hdr "B. What IS the :241 webapp? (interrogate it, don't assume)"
# A NullPointer on every command usually means wrong request SCHEMA, not wrong
# credentials. See what the app says about itself.

echo ">>> B1. GET the host root"
get "$REMOTE_ROOT"

echo ">>> B2. GET the /TSL/ webapp root"
get "$REMOTE_APP"

echo ">>> B3. GET the /TSL/kra endpoint (does it describe itself on GET?)"
get "$REMOTE"

echo ">>> B4. POST an intentionally EMPTY body — does the error change?"
post "$REMOTE" ""

echo ">>> B5. POST a minimal well-formed but unknown command — same 500 or different?"
post "$REMOTE" "<Request Name=\"Ping\"></Request>"

# ===========================================================================
hdr "C. Health of the raw Control Unit TCP port (if nc/bash /dev/tcp works)"
if command -v nc >/dev/null 2>&1; then
  nc -z -w5 "$DEVICE_IP" "$DEVICE_PORT" && echo "  ${DEVICE_IP}:${DEVICE_PORT} OPEN" || echo "  ${DEVICE_IP}:${DEVICE_PORT} UNREACHABLE"
else
  # bash /dev/tcp fallback
  if (exec 3<>"/dev/tcp/${DEVICE_IP}/${DEVICE_PORT}") 2>/dev/null; then
    echo "  ${DEVICE_IP}:${DEVICE_PORT} OPEN (via /dev/tcp)"; exec 3>&- 2>/dev/null
  else
    echo "  ${DEVICE_IP}:${DEVICE_PORT} UNREACHABLE (via /dev/tcp) — but this may just mean the port"
    echo "  is not directly reachable from the till; the ZFPLabServer may still reach it."
  fi
fi

hdr "DONE — what each result means"
echo "  A returns Code=0                -> USE :4444. Device is fine; app is pointed at the wrong URL."
echo "  A also 500s / refuses           -> local ZFPLabServer isn't wired to the device either; its"
echo "                                     own Settings/Connect TCP must be run in its GUI first."
echo "  B1/B2 list a webapp name/version-> tells us what :241 really is (KRA TIMS vs ZFP)."
echo "  B4 empty body = SAME 500        -> server dies before reading body = wrong endpoint/schema,"
echo "                                     NOT our credentials."
echo "  B4 empty body = DIFFERENT error -> it does parse our body; schema is closer than thought."