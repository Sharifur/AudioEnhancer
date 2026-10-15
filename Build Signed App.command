#!/bin/bash
# Double-click: build Voice Enhancer signed with your Apple certificate, install it and open it.
cd "$(dirname "$0")" || exit 1
./scripts/build-signed-mac.sh 2>&1 | tee build-signed.log
echo
read -n 1 -s -r -p "Press any key to close..."
