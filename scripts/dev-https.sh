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

# The default route names the interface carrying traffic, which is usually the
# one the phone can reach - but not when a VPN is up, where it is a utun/ppp
# tunnel with an address no phone on the Wi-Fi can talk to. So a tunnel is
# skipped in favour of a real interface.
lan_address() {
  local iface ip
  iface="$(route get default 2>/dev/null | awk '/interface:/{print $2}' || true)"
  case "$iface" in
    "" | utun* | ppp* | ipsec* | tun*)
      # A VPN, or no route at all. Take the first hardware interface with an
      # address instead. en0/en1 differ between Macs - Wi-Fi is en0 on a laptop
      # and often en1 where there is also ethernet - so several are tried.
      for iface in en0 en1 en2 en3; do
        ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
        [ -n "$ip" ] && { echo "$ip"; return 0; }
      done
      return 1
      ;;
  esac
  ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
  [ -n "$ip" ] || return 1
  echo "$ip"
}

IP="$(lan_address || true)"
if [ -z "$IP" ]; then
  echo "Could not work out this machine's address on the network." >&2
  echo "Is Wi-Fi on? Check with: ipconfig getifaddr en0" >&2
  exit 1
fi

PORT="${PORT:-3000}"
DIR=certificates
KEY="$DIR/localhost-key.pem"
CRT="$DIR/localhost.pem"

# -------------------------------------------------------------- certificate

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
  # an interrupted run cannot leave a truncated or mismatched pair behind.
  tmpkey="$(mktemp "$DIR/.key.XXXXXX")"
  tmpcrt="$(mktemp "$DIR/.crt.XXXXXX")"
  trap 'rm -f "$tmpkey" "$tmpcrt"' EXIT
  chmod 600 "$tmpkey"
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout "$tmpkey" -out "$tmpcrt" \
    -subj "/CN=AmReceipts dev" \
    -addext "subjectAltName=IP:$IP,IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1
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
echo

exec npx next dev --experimental-https \
  --experimental-https-key "$KEY" \
  --experimental-https-cert "$CRT" \
  -H 0.0.0.0 -p "$PORT"
