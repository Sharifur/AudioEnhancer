#!/bin/bash
# Build Voice Enhancer signed with YOUR Apple certificate (from your login keychain),
# optionally notarize it, install it to /Applications and open it.
#
#   ./scripts/build-signed-mac.sh            # auto-picks your certificate
#   CERT="Developer ID Application: Name (TEAMID)" ./scripts/build-signed-mac.sh
#
# Notarization (optional, needed only to share the .dmg with other Macs):
#   one-time:  xcrun notarytool store-credentials VoiceEnhancer \
#                --apple-id you@example.com --team-id TEAMID
#   (it asks for an app-specific password from appleid.apple.com)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
NOTARY_PROFILE="${NOTARY_PROFILE:-VoiceEnhancer}"
fail() { echo "STATUS: FAILED ($1)"; exit 1; }

echo "== Voice Enhancer: signed build =="
command -v node >/dev/null || { command -v brew >/dev/null && brew install node; } || fail "Node.js missing: install from https://nodejs.org"
echo "node $(node -v)"

# ---- pick a signing certificate -------------------------------------------
IDS="$(security find-identity -v -p codesigning | sed -n 's/.*"\(.*\)"$/\1/p')"
echo "Code-signing certificates in your keychain:"; echo "${IDS:-  (none)}" | sed 's/^/  /'
if [ -z "${CERT:-}" ]; then
  CERT="$(echo "$IDS" | grep '^Developer ID Application:' | head -1)"
  [ -z "$CERT" ] && CERT="$(echo "$IDS" | grep -E '^(Apple Development|Mac Developer):' | head -1)"
fi
[ -z "$CERT" ] && fail "no Apple code-signing certificate found in your keychain (Xcode > Settings > Accounts > Manage Certificates)"
echo "Signing with: $CERT"

case "$CERT" in
  "Developer ID Application:"*) TYPE=distribution; NAME="${CERT#Developer ID Application: }" ;;
  *)                            TYPE=development;  NAME="$CERT" ;;
esac

NOTARIZE=false
if [ "$TYPE" = distribution ] && xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
  NOTARIZE=true; export APPLE_KEYCHAIN_PROFILE="$NOTARY_PROFILE"
  echo "Notarization: ON (keychain profile '$NOTARY_PROFILE')"
else
  echo "Notarization: off (fine for this Mac; see header of this script to enable for sharing)"
fi

# ---- build -----------------------------------------------------------------
echo "== Installing dependencies =="
npm ci --no-audit --no-fund || fail "npm ci"
rm -rf dist
echo "== Building + signing (macOS may ask to let codesign use your key: click Always Allow) =="
CSC_NAME="$NAME" npx electron-builder --mac dir dmg --arm64 --publish never \
  -c.mac.identity="$NAME" \
  -c.mac.type="$TYPE" \
  -c.mac.hardenedRuntime=true \
  -c.mac.gatekeeperAssess=false \
  -c.mac.entitlements=build/entitlements.mac.plist \
  -c.mac.entitlementsInherit=build/entitlements.mac.plist \
  -c.mac.notarize=$NOTARIZE || fail "build/sign"

APP="dist/mac-arm64/Voice Enhancer.app"
echo "== Verifying signature =="
codesign --verify --deep --strict --verbose=2 "$APP" || fail "signature verify"
codesign -dv "$APP" 2>&1 | grep -E "Authority|TeamIdentifier|Runtime" | head -5
spctl -a -vv "$APP" 2>&1 | head -3 || true

echo "== Installing to /Applications =="
rm -rf "/Applications/Voice Enhancer.app"
cp -R "$APP" /Applications/ || fail "copy to /Applications"
open "/Applications/Voice Enhancer.app"
echo "Shareable installer: $(ls dist/*.dmg)"
echo "STATUS: OK"
