#!/usr/bin/env bash
# Builds the Framecast Windows installer from Linux (or macOS with the same tools).
#
#   packaging/windows/build.sh
#
# Output: dist/Framecast-Setup-<version>.exe and dist/Framecast-<version>-win-x64.zip
#
# How it works:
#   1. Bundle server.js and lib/ into one CommonJS file with esbuild.
#   2. Turn that into a Node single-executable-application (SEA) blob.
#   3. Copy the official Windows node.exe, strip its (now invalid) signature,
#      set the Framecast icon/version, and inject the blob -> Framecast.exe.
#   4. Stage Framecast.exe with public/, fonts, a Windows ffmpeg and notices.
#   5. Compile the NSIS installer and a portable zip.
#
# Needs: curl, unzip, sha256sum, makensis (NSIS 3), osslsigncode, npm.
# Downloads are cached in packaging/windows/.cache and checked against the
# publishers' SHA-256 lists.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CACHE="$HERE/.cache"
BUILD="$HERE/.build"
DIST="$ROOT/dist"
STAGE="$BUILD/stage"

VERSION="$(node -p "require('$ROOT/package.json').version")"
NODE_VERSION="24.22.1"   # Windows runtime embedded in Framecast.exe
FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"
FFMPEG_SUMS="https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/checksums.sha256"
SEA_FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"

step() { printf '\n==> %s\n' "$*"; }
need() { command -v "$1" >/dev/null || { echo "Missing required tool: $1" >&2; exit 1; }; }
for t in curl unzip sha256sum makensis osslsigncode npm; do need "$t"; done

# Download $1 to $2 unless cached, then require its SHA-256 to match $3.
fetch_verified() {
  local url="$1" out="$2" expected="$3"
  if [[ ! -f "$out" ]] || [[ "$(sha256sum "$out" | cut -d' ' -f1)" != "$expected" ]]; then
    echo "Downloading $url"
    curl -fSL --retry 3 -o "$out.part" "$url"
    mv "$out.part" "$out"
  fi
  local actual; actual="$(sha256sum "$out" | cut -d' ' -f1)"
  if [[ "$actual" != "$expected" ]]; then
    echo "Checksum mismatch for $out: expected $expected, got $actual" >&2
    exit 1
  fi
}

mkdir -p "$CACHE"
rm -rf "$BUILD"
mkdir -p "$BUILD" "$STAGE" "$DIST"

step "Installing packaging tools"
(cd "$HERE" && npm install --no-audit --no-fund --silent)

step "Fetching Node.js $NODE_VERSION (Windows runtime + matching host runtime)"
curl -fsSL -o "$CACHE/node-SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
sum_for() { grep " $1\$" "$CACHE/node-SHASUMS256.txt" | cut -d' ' -f1; }
WIN_ZIP="node-v$NODE_VERSION-win-x64.zip"
fetch_verified "https://nodejs.org/dist/v$NODE_VERSION/$WIN_ZIP" "$CACHE/$WIN_ZIP" "$(sum_for "$WIN_ZIP")"

# The SEA blob must be produced by the same Node version that will run it.
HOST_NODE="node"
if [[ "$(node --version)" != "v$NODE_VERSION" ]]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) HOST_TAR="node-v$NODE_VERSION-linux-x64.tar.xz" ;;
    Linux-aarch64) HOST_TAR="node-v$NODE_VERSION-linux-arm64.tar.xz" ;;
    Darwin-arm64) HOST_TAR="node-v$NODE_VERSION-darwin-arm64.tar.xz" ;;
    Darwin-x86_64) HOST_TAR="node-v$NODE_VERSION-darwin-x64.tar.xz" ;;
    *) echo "Unsupported build host; install Node $NODE_VERSION and rerun." >&2; exit 1 ;;
  esac
  fetch_verified "https://nodejs.org/dist/v$NODE_VERSION/$HOST_TAR" "$CACHE/$HOST_TAR" "$(sum_for "$HOST_TAR")"
  tar -xJf "$CACHE/$HOST_TAR" -C "$BUILD"
  HOST_NODE="$BUILD/${HOST_TAR%.tar.xz}/bin/node"
fi
echo "Host runtime: $("$HOST_NODE" --version)"

step "Fetching ffmpeg for Windows"
curl -fsSL -o "$CACHE/ffmpeg-checksums.sha256" "$FFMPEG_SUMS"
FFMPEG_SHA="$(grep 'ffmpeg-master-latest-win64-gpl.zip$' "$CACHE/ffmpeg-checksums.sha256" | cut -d' ' -f1)"
fetch_verified "$FFMPEG_URL" "$CACHE/ffmpeg-win64-gpl.zip" "$FFMPEG_SHA"

step "Bundling the server"
"$HERE/node_modules/.bin/esbuild" "$ROOT/server.js" \
  --bundle --platform=node --format=cjs --target=node24 \
  --log-override:empty-import-meta=silent \
  --outfile="$BUILD/framecast.cjs"

step "Creating the single-executable blob"
cat > "$BUILD/sea-config.json" <<EOF
{
  "main": "$BUILD/framecast.cjs",
  "output": "$BUILD/sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": false
}
EOF
"$HOST_NODE" --experimental-sea-config "$BUILD/sea-config.json"

step "Building Framecast.exe"
unzip -q -o "$CACHE/$WIN_ZIP" "node-v$NODE_VERSION-win-x64/node.exe" "node-v$NODE_VERSION-win-x64/LICENSE" -d "$BUILD"
osslsigncode remove-signature -in "$BUILD/node-v$NODE_VERSION-win-x64/node.exe" -out "$BUILD/Framecast.exe" >/dev/null
# Inject before editing resources: postject's PE parser rejects the relocation
# layout resedit writes ("Relocation corrupted"), while resedit keeps the
# injected NODE_SEA_BLOB resource intact.
"$HERE/node_modules/.bin/postject" "$BUILD/Framecast.exe" NODE_SEA_BLOB "$BUILD/sea-prep.blob" \
  --sentinel-fuse "$SEA_FUSE" 2>&1 | tee "$BUILD/postject.log"
if grep -qi '^error' "$BUILD/postject.log"; then echo "postject reported an error" >&2; exit 1; fi
"$HOST_NODE" "$HERE/set-exe-resources.mjs" "$BUILD/Framecast.exe" "$HERE/framecast.ico" "$VERSION"

step "Staging files"
cp "$BUILD/Framecast.exe" "$STAGE/"
cp -r "$ROOT/public" "$STAGE/public"
mkdir -p "$STAGE/fonts" "$STAGE/ffmpeg"
cp /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf "$STAGE/fonts/" 2>/dev/null \
  || cp "$HERE/fonts/"DejaVuSans*.ttf "$STAGE/fonts/"
unzip -q -j -o "$CACHE/ffmpeg-win64-gpl.zip" "*/bin/ffmpeg.exe" "*/LICENSE.txt" -d "$BUILD/ffmpeg"
cp "$BUILD/ffmpeg/ffmpeg.exe" "$STAGE/ffmpeg/"
cp "$BUILD/ffmpeg/LICENSE.txt" "$STAGE/ffmpeg/LICENSE.txt"

FONT_LICENSE="/usr/share/doc/fonts-dejavu-core/copyright"
[[ -f "$FONT_LICENSE" ]] || FONT_LICENSE="$HERE/fonts/LICENSE"
{
  echo "Framecast $VERSION bundles the following third-party software."
  echo
  echo "Please read before installing. Clicking \"I Agree\" accepts these licenses."
  echo
  echo "================================================================"
  echo "Node.js $NODE_VERSION (embedded in Framecast.exe) - MIT license and bundled licenses"
  echo "https://nodejs.org/"
  echo "================================================================"
  cat "$BUILD/node-v$NODE_VERSION-win-x64/LICENSE"
  echo
  echo "================================================================"
  echo "FFmpeg (ffmpeg\\ffmpeg.exe) - GPL v3 build by BtbN/FFmpeg-Builds"
  echo "Source code: https://github.com/BtbN/FFmpeg-Builds and https://ffmpeg.org/download.html"
  echo "Checksum of the archive used: $FFMPEG_SHA"
  echo "================================================================"
  cat "$BUILD/ffmpeg/LICENSE.txt"
  echo
  echo "================================================================"
  echo "DejaVu fonts (fonts\\) - Bitstream Vera / DejaVu license"
  echo "================================================================"
  cat "$FONT_LICENSE"
} | sed 's/$/\r/' > "$STAGE/THIRD-PARTY-NOTICES.txt"

sed 's/$/\r/' > "$STAGE/README.txt" <<EOF
Framecast $VERSION
==================

Start Framecast from the Start menu or the desktop shortcut. A console window
opens and Framecast appears in your web browser. Keep the console window open
while you use it; close it to quit.

Your videos and credits are stored in:
  %LOCALAPPDATA%\\Framecast\\data

This build runs in demo mode: videos are placeholder renders made on your
computer with the bundled ffmpeg, not real AI output.

Uninstall from Settings > Apps, or "Uninstall Framecast" in the Start menu.
EOF

step "Compiling the installer"
SETUP="$DIST/Framecast-Setup-$VERSION.exe"
(cd "$HERE" && makensis -V2 -DVERSION="$VERSION" -DSTAGE="$STAGE" -DOUTFILE="$SETUP" installer.nsi)

step "Creating the portable zip"
PORTABLE="$DIST/Framecast-$VERSION-win-x64.zip"
rm -f "$PORTABLE"
(cd "$STAGE" && zip -qr -9 "$PORTABLE" .)

step "Done"
ls -lh "$SETUP" "$PORTABLE"
sha256sum "$SETUP" "$PORTABLE" | tee "$DIST/SHA256SUMS.txt"
