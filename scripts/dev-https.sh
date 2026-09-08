#!/usr/bin/env bash
# Run the dev server over HTTPS on the local network, for testing on a phone.
#
#   npm run dev:phone
#
# HTTPS is not decoration here. `getUserMedia` - the camera - is only available
# in a "secure context", which means HTTPS or localhost. A phone reaching this
# Mac at http://10.0.1.87:3000 is neither, so the capture screen falls back to
# the file picker and auto-capture can never be tested at all.
#
# The certificate is self-signed and generated here, so the phone will warn
# about it once and you tell it to continue. That is expected. The certificate
# itself is public - the phone receives it during the handshake, as it does from
# any site - but the private key stays on this machine, and both files are
# gitignored.
#
# Written against the openssl macOS actually ships, which is LibreSSL and not
# OpenSSL. It has no `x509 -ext`, so the certificate's names are read out of
# `-text` instead.
set -euo pipefail

cd "$(dirname "$0")/.."

# ------------------------------------------------------------------ address

# The addresses a phone might be able to reach this machine on, best first.
#
# The phone is on Wi-Fi, so Wi-Fi comes first - by name, from the system's own
# list of hardware ports, not by guessing at en0. That guess is wrong on any Mac
# with Ethernet: here en0 IS the Ethernet port and Wi-Fi is en1, and following
# the default route instead would hand out an Ethernet address the moment a dock
# was plugged in, which no phone on the Wi-Fi can reach.
#
# Every hardware port the system lists is then tried, rather than a hardcoded
# en0-en4, so a machine whose Wi-Fi is en5 or whose addresses live on a dock is
# not silently missed.
lan_addresses() {
  local wifi ports iface ip seenIface=" " seenIp=" "
  wifi="$(networksetup -listallhardwareports 2>/dev/null \
    | awk '/^Hardware Port: Wi-Fi/{getline; print $2; exit}')"
  ports="$(networksetup -listallhardwareports 2>/dev/null | awk '/^Device:/{print $2}')"

  for iface in "$wifi" "$(route get default 2>/dev/null | awk '/interface:/{print $2}')" $ports; do
    case "$iface" in
      "" | utun* | ppp* | ipsec* | tun* | bridge*) continue ;;  # reaches no phone
    esac
    case "$seenIface" in *" $iface "*) continue ;; esac
    seenIface="$seenIface$iface "
    ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
    if [ -n "$ip" ]; then
      # Two devices can report the same address; the certificate should not
      # name it twice.
      case "$seenIp" in *" $ip "*) continue ;; esac
      seenIp="$seenIp$ip "
      echo "$ip"
    fi
  done
}

ADDRESSES="$(lan_addresses || true)"
IP="$(printf '%s\n' "$ADDRESSES" | head -1)"
if [ -z "$IP" ]; then
  echo "Could not work out this machine's address on the network." >&2
  echo "Is Wi-Fi on? Check with: ipconfig getifaddr en0" >&2
  exit 1
fi

PORT="${PORT:-3000}"

# Said plainly, before Next says it as a raw Node stack trace.
#
# Something already listening on the port is the likeliest reason this does not
# start, and `EADDRINUSE` buried in a `net.js` backtrace does not look like
# "you already have a dev server running" to anyone reading it in a hurry.
# Captured once rather than asked twice: between two calls the listener can
# vanish, and under `pipefail` the second one failing would end the script
# before it printed the advice.
if listeners="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)" && [ -n "$listeners" ]; then
  echo "Something is already listening on port $PORT:" >&2
  # One consumer, not three. `tail | head | sed` under `pipefail` lets `head`
  # close the pipe early, `tail` take a SIGPIPE, and the script end before it
  # prints the advice below - the same trap this script already had once.
  printf '%s\n' "$listeners" | awk 'NR >= 2 && NR <= 4 { print "  " $0 }' >&2
  echo >&2
  echo "  Stop it, or run this on another port:  PORT=3001 npm run dev:phone" >&2
  exit 1
fi

DIR=certificates
KEY="$DIR/localhost-key.pem"
CRT="$DIR/localhost.pem"

# -------------------------------------------------------------- certificate

# Every address `lan_addresses` found, so whichever one the phone can actually
# reach is named by the certificate. A certificate that does not name the
# address you typed is rejected by Safari outright, with no option to continue.
san_list() {
  local out="" ip
  while IFS= read -r ip; do
    if [ -n "$ip" ]; then out="${out}IP:$ip,"; fi
  done <<EOF_ADDR
$ADDRESSES
EOF_ADDR
  echo "${out}IP:127.0.0.1,DNS:localhost"
}


# Everything that has to hold before an existing pair is reused. A certificate
# failing any of these makes `next dev` either refuse to start or serve
# something the phone rejects, and both look like a broken app rather than a
# stale file left over from another network.
cert_is_usable() {
  [ -r "$CRT" ] && [ -r "$KEY" ] || return 1

  # Names the address you are about to type. Matched between delimiters rather
  # than by substring: `grep "IP Address:$IP"` accepts a certificate for
  # 10.0.1.87 as one for 10.0.1.8, and the phone then rejects it outright with
  # no option to continue.
  local names
  names="$(openssl x509 -in "$CRT" -noout -text 2>/dev/null || true)"
  names="$(printf '%s' "$names" | grep -A1 'Subject Alternative Name' | tail -1 || true)"
  # Whitespace stripped and comma-wrapped so the match has a delimiter on both
  # sides. Held in a variable rather than piped into `grep -q`, which under
  # `pipefail` fails the pipeline when grep exits early and openssl takes a
  # SIGPIPE.
  case ",${names//[[:space:]]/}," in
    *",IPAddress:$IP,"*) ;;
    *) return 1 ;;
  esac

  # Still valid tomorrow, so a session does not die at midnight.
  openssl x509 -in "$CRT" -noout -checkend 86400 >/dev/null 2>&1 || return 1

  # The key actually belongs to the certificate. A pair left half-written by an
  # interrupted run satisfies every check above and none of the ones that
  # count: node refuses to start with "key values mismatch", which reads as the
  # app being broken.
  local from_cert from_key
  from_cert="$(openssl x509 -in "$CRT" -noout -pubkey 2>/dev/null | openssl md5 2>/dev/null || true)"
  from_key="$(openssl pkey -in "$KEY" -pubout 2>/dev/null | openssl md5 2>/dev/null || true)"
  [ -n "$from_cert" ] && [ "$from_cert" = "$from_key" ]
}

if ! cert_is_usable; then
  mkdir -p "$DIR"
  echo "Making a certificate for $IP …"
  # Written to temporary files and moved into place only once both are good, so
  # an interrupted openssl cannot leave a truncated pair behind. The two moves
  # are still two operations - a kill between them leaves a new key beside an
  # old certificate - which is why `cert_is_usable` checks that the key matches
  # rather than trusting the pair to have arrived together.
  tmpkey="$(mktemp "$DIR/.key.XXXXXX")"
  tmpcrt="$(mktemp "$DIR/.crt.XXXXXX")"
  trap 'rm -f "$tmpkey" "$tmpcrt"' EXIT
  chmod 600 "$tmpkey"
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout "$tmpkey" -out "$tmpcrt" \
    -subj "/CN=AmReceipts dev" \
    -addext "subjectAltName=$(san_list)" >/dev/null 2>&1
  openssl x509 -in "$tmpcrt" -noout >/dev/null 2>&1 || {
    echo "Certificate generation failed. Is openssl on PATH?" >&2
    exit 1
  }
  mv "$tmpkey" "$KEY"
  mv "$tmpcrt" "$CRT"
  trap - EXIT
fi

# Enforced on every run, not only the one that created it: a key left readable
# by an earlier version of this script would otherwise stay that way.
chmod 600 "$KEY"

echo
echo "  On the phone, open:  https://$IP:$PORT"
echo "  Both devices must be on the same Wi-Fi."
echo "  The phone will warn about the certificate once — continue past it."
# Listed because the first one is a best guess. If the phone cannot reach it,
# one of these will be the right one, and the certificate names them all.
others="$(printf '%s\n' "$ADDRESSES" | tail -n +2)"
if [ -n "$others" ]; then
  echo
  echo "  If that address does not answer, this machine is also at:"
  printf '%s\n' "$others" | sed "s|^|    https://|;s|$|:$PORT|"
fi
echo

exec npx next dev --experimental-https \
  --experimental-https-key "$KEY" \
  --experimental-https-cert "$CRT" \
  -H 0.0.0.0 -p "$PORT"
