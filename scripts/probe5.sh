#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Probe 5 — envelope is now KNOWN: <Command Name="...">...</Command>.
# Find the exact settings command spelling, then confirm ReadStatus -> Code 0.
# Read-only. No receipt is opened.
#   bash probe5.sh > result5.txt 2>&1
# ---------------------------------------------------------------------------
LOCAL="http://localhost:4444"
IP="154.79.253.236"; PORT="8000"; PW="Password"
CT='Content-Type: text/xml'; ACC='Accept: text/xml, application/xml'; T=10
line(){ printf '%s\n' "----------------------------------------------------------------------"; }

# send <label> <body>  — and if Code 0, immediately follow with ReadStatus
send(){
  printf '\n>>> %s\n' "$1"; printf 'BODY %s\n' "$2"
  local out; out=$(curl -sS -m "$T" -w '\n[HTTP %{http_code}]' -H "$CT" -H "$ACC" -X POST "$LOCAL" --data "$2" 2>&1)
  printf '%s\n' "$out"
  if printf '%s' "$out" | grep -q 'Code="0"'; then
    printf '    *** Code 0! settings accepted. Now confirming the device answers:\n'
    printf '    --- ReadStatus ---\n'
    curl -sS -m "$T" -w '\n[HTTP %{http_code}]\n' -H "$CT" -H "$ACC" -X POST "$LOCAL" \
      --data '<Command Name="ReadStatus"></Command>' 2>&1
    printf '    --- ReadDateTime ---\n'
    curl -sS -m "$T" -w '\n[HTTP %{http_code}]\n' -H "$CT" -H "$ACC" -X POST "$LOCAL" \
      --data '<Command Name="ReadDateTime"></Command>' 2>&1
    printf '    --- ReadVATrates ---\n'
    curl -sS -m "$T" -w '\n[HTTP %{http_code}]\n' -H "$CT" -H "$ACC" -X POST "$LOCAL" \
      --data '<Command Name="ReadVATrates"></Command>' 2>&1
  fi
}

line; echo "### Envelope confirmed: <Command Name=\"...\">. Finding the settings spelling."; line

# The demo UI shows: Settings(com=,baud=,tcp=1,ip=...,port=8000,password=Password)
# Try the likely command NAMEs with args as child tags inside <Command>.
ARGS="<com></com><baud></baud><tcp>1</tcp><ip>${IP}</ip><port>${PORT}</port><password>${PW}</password>"

send "1. Name=settings (lowercase) + child-tag args" \
"<Command Name=\"settings\">${ARGS}</Command>"

send "2. Name=Settings (capital) + child-tag args" \
"<Command Name=\"Settings\">${ARGS}</Command>"

send "3. Name=ServerSetDeviceTcpSettings + child-tag args" \
"<Command Name=\"ServerSetDeviceTcpSettings\"><ip>${IP}</ip><port>${PORT}</port><password>${PW}</password></Command>"

# Args as ATTRIBUTES on the Command element (some zfpdef commands take attrs)
send "4. Name=settings + attribute args" \
"<Command Name=\"settings\" com=\"\" baud=\"\" tcp=\"1\" ip=\"${IP}\" port=\"${PORT}\" password=\"${PW}\"></Command>"

send "5. Name=Settings + attribute args" \
"<Command Name=\"Settings\" com=\"\" baud=\"\" tcp=\"1\" ip=\"${IP}\" port=\"${PORT}\" password=\"${PW}\"></Command>"

# Named-arg child element style: <Arg Name="ip" Value="..."/> (common zfpdef shape)
send "6. Name=Settings + <Arg Name=.. Value=..> children" \
"<Command Name=\"Settings\"><Arg Name=\"tcp\" Value=\"1\"/><Arg Name=\"ip\" Value=\"${IP}\"/><Arg Name=\"port\" Value=\"${PORT}\"/><Arg Name=\"password\" Value=\"${PW}\"/></Command>"

# TCP-specific spelling seen in Tremol SDKs
send "7. Name=SetTCP / TCPConnect style" \
"<Command Name=\"TCPConnect\"><ip>${IP}</ip><port>${PORT}</port><password>${PW}</password></Command>"

line; echo "READ THE RESULTS:"; line
echo "  * The variant returning <Res Code=\"0\"> is the correct settings command."
echo "    Its auto-run ReadStatus then shows the 6-byte status incl:"
echo "        CU_fiscalized Value=\"1\"      -> device fiscalized"
echo "        Paired_with_TIMS Value=\"1\"   -> paired with KRA TIMS"
echo "    THAT is the definitive 'integration works' proof. No invoice needed."
echo "  * Code 53 still -> that spelling didn't set params; try next."
echo "  * Code 10 -> wrong NAME for that variant."
echo "  * Code 5x with an <Err> naming ip/port/password -> we're inside the command;"
echo "    the arg SHAPE is off by a little. Note which field it complains about."