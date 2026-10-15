#!/bin/bash
# Double-click to build Voice Enhancer.app, install it to /Applications and open it.
cd "$(dirname "$0")" || exit 1
exec > >(tee install.log) 2>&1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

echo "== Voice Enhancer installer =="
if ! command -v node >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "Node.js not found. Installing with Homebrew..."
    brew install node || { echo "STATUS: FAILED (brew install node)"; exit 1; }
  else
    echo "Node.js is not installed. Get it from https://nodejs.org (LTS), then double-click this file again."
    echo "STATUS: FAILED (no node)"; read -n 1 -s -r -p "Press any key to close..."; exit 1
  fi
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
echo "node $(node -v), npm $(npm -v)"
if [ "$NODE_MAJOR" -lt 20 ]; then echo "Node 20+ needed. STATUS: FAILED (old node)"; exit 1; fi

echo "== Installing dependencies =="
npm ci --no-audit --no-fund || { echo "STATUS: FAILED (npm ci)"; exit 1; }
echo "== Building and installing the app =="
npm run install-app || { echo "STATUS: FAILED (build)"; exit 1; }
echo "== Opening Voice Enhancer =="
open "/Applications/Voice Enhancer.app"
echo "STATUS: OK"
