#!/usr/bin/env bash
set -euo pipefail

# Build Optimization Opt-outs (set to 0 to disable, default: 1):
#   DSH_BUILD_EATMYDATA=0       - Disable eatmydata wrapper around dpkg-deb
#   DSH_BUILD_PARALLEL_ICONS=0  - Run icon conversions sequentially
#   DSH_BUILD_TMPFS=0           - Build in ./build instead of /dev/shm
#   DSH_BUILD_CCACHE=0          - Disable ccache environment export

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_NAME="dsh-desktop"
PACKAGE_VERSION="1.1.1"
PACKAGE_ARCH="$(dpkg-architecture -qDEB_HOST_ARCH)"
PACKAGE_FULLNAME="${PACKAGE_NAME}_${PACKAGE_VERSION}_${PACKAGE_ARCH}"
DEB_FILE="${SCRIPT_DIR}/${PACKAGE_FULLNAME}.deb"

# Clamp timestamps for byte-reproducible deb packaging
if [ -z "${SOURCE_DATE_EPOCH:-}" ]; then
    if [ -f "${SCRIPT_DIR}/debian/changelog" ] && command -v dpkg-parsechangelog >/dev/null 2>&1; then
        SOURCE_DATE_EPOCH="$(dpkg-parsechangelog -l "${SCRIPT_DIR}/debian/changelog" -STimestamp 2>/dev/null || date +%s)"
    elif command -v git >/dev/null 2>&1 && git -C "${SCRIPT_DIR}" rev-parse --git-dir >/dev/null 2>&1; then
        SOURCE_DATE_EPOCH="$(git -C "${SCRIPT_DIR}" log -1 --format=%ct 2>/dev/null || date +%s)"
    else
        SOURCE_DATE_EPOCH="$(date +%s)"
    fi
    export SOURCE_DATE_EPOCH
fi

# Detect tmpfs availability in /dev/shm (require >= 2 GB free)
USE_TMPFS=0
if [ "${DSH_BUILD_TMPFS:-1}" != "0" ]; then
    if [ -d /dev/shm ]; then
        SHM_AVAIL_KB="$(df -k /dev/shm 2>/dev/null | awk 'NR==2 {print $4}')"
        if [ -n "$SHM_AVAIL_KB" ] && [ "$SHM_AVAIL_KB" -ge 2097152 ]; then
            USE_TMPFS=1
        else
            echo "Notice: /dev/shm has less than 2 GB available. Skipping tmpfs build dir."
        fi
    else
        echo "Notice: /dev/shm not found. Skipping tmpfs build dir."
    fi
fi

if [ "$USE_TMPFS" -eq 1 ]; then
    BUILD_DIR="/dev/shm/dsh-build-$$"
else
    BUILD_DIR="${SCRIPT_DIR}/build"
fi
TMPFS_DEB_FILE="${BUILD_DIR}/${PACKAGE_FULLNAME}.deb"
STAGING_DIR="${BUILD_DIR}/${PACKAGE_FULLNAME}"

cleanup() {
    local exit_code=$?
    if [ "$USE_TMPFS" -eq 1 ] && [ -d "$BUILD_DIR" ]; then
        if [ -f "$TMPFS_DEB_FILE" ]; then
            rsync -a "$TMPFS_DEB_FILE" "$DEB_FILE" 2>/dev/null || cp -f "$TMPFS_DEB_FILE" "$DEB_FILE" 2>/dev/null || true
        fi
        rm -rf "$BUILD_DIR"
    fi
    exit "$exit_code"
}
trap cleanup EXIT INT TERM

# Configure ccache wrapper if available
if [ "${DSH_BUILD_CCACHE:-1}" != "0" ]; then
    if command -v ccache >/dev/null 2>&1 && command -v gcc >/dev/null 2>&1; then
        export CC="ccache gcc"
        export CXX="ccache g++"
    else
        echo "Notice: ccache or gcc not found. Skipping ccache configuration."
    fi
fi

echo "=== Building Debian Package: ${PACKAGE_FULLNAME} ==="

# 1. Check for required build tools
echo "[1/6] Checking required build tools..."
MISSING_TOOLS=0

if ! command -v dpkg-deb >/dev/null 2>&1; then
    echo "Error: 'dpkg-deb' is required but not installed. Install with: sudo apt install -y dpkg" >&2
    MISSING_TOOLS=1
fi

if ! command -v dpkg-architecture >/dev/null 2>&1; then
    echo "Error: 'dpkg-architecture' is required but not installed. Install with: sudo apt install -y dpkg-dev" >&2
    MISSING_TOOLS=1
fi

if ! command -v convert >/dev/null 2>&1; then
    echo "Error: 'convert' (ImageMagick) is required to generate icons. Install with: sudo apt install -y imagemagick" >&2
    MISSING_TOOLS=1
fi

HAS_FAKEROOT=1
if ! command -v fakeroot >/dev/null 2>&1; then
    echo "Warning: 'fakeroot' is not installed. Will use 'dpkg-deb --root-owner-group'."
    HAS_FAKEROOT=0
fi

HAS_LINTIAN=1
if ! command -v lintian >/dev/null 2>&1; then
    echo "Warning: 'lintian' is not installed. Skipping lintian check. (Install with: sudo apt install -y lintian)"
    HAS_LINTIAN=0
fi

if [ "$MISSING_TOOLS" -ne 0 ]; then
    exit 1
fi

# Ensure PNG icons are up to date with SVG
if [ ! -f "${SCRIPT_DIR}/usr/share/dsh-desktop/logo.svg" ]; then
    echo "Error: '${SCRIPT_DIR}/usr/share/dsh-desktop/logo.svg' is missing." >&2
    exit 1
fi
mkdir -p "${SCRIPT_DIR}/usr/share/icons/hicolor/128x128/apps"
mkdir -p "${SCRIPT_DIR}/usr/share/icons/hicolor/24x24/apps"
if [ "${DSH_BUILD_PARALLEL_ICONS:-1}" != "0" ]; then
    convert -background none -resize 128x128 "${SCRIPT_DIR}/usr/share/dsh-desktop/logo.svg" "${SCRIPT_DIR}/usr/share/icons/hicolor/128x128/apps/dsh-desktop.png" &
    PID1=$!
    convert -background none -resize 24x24 "${SCRIPT_DIR}/usr/share/dsh-desktop/logo.svg" "${SCRIPT_DIR}/usr/share/dsh-desktop/tray-icon.png" &
    PID2=$!
    convert -background none -resize 24x24 "${SCRIPT_DIR}/usr/share/dsh-desktop/logo.svg" "${SCRIPT_DIR}/usr/share/icons/hicolor/24x24/apps/dsh-desktop.png" &
    PID3=$!
    wait "$PID1" && wait "$PID2" && wait "$PID3"
else
    convert -background none -resize 128x128 "${SCRIPT_DIR}/usr/share/dsh-desktop/logo.svg" "${SCRIPT_DIR}/usr/share/icons/hicolor/128x128/apps/dsh-desktop.png"
    convert -background none -resize 24x24 "${SCRIPT_DIR}/usr/share/dsh-desktop/logo.svg" "${SCRIPT_DIR}/usr/share/dsh-desktop/tray-icon.png"
    convert -background none -resize 24x24 "${SCRIPT_DIR}/usr/share/dsh-desktop/logo.svg" "${SCRIPT_DIR}/usr/share/icons/hicolor/24x24/apps/dsh-desktop.png"
fi

for icon in \
    "${SCRIPT_DIR}/usr/share/dsh-desktop/logo.svg" \
    "${SCRIPT_DIR}/usr/share/dsh-desktop/tray-icon.png" \
    "${SCRIPT_DIR}/usr/share/icons/hicolor/128x128/apps/dsh-desktop.png" \
    "${SCRIPT_DIR}/usr/share/icons/hicolor/24x24/apps/dsh-desktop.png"; do
    if [ ! -f "$icon" ]; then
        echo "Error: Required icon '$icon' was not generated or is missing." >&2
        exit 1
    fi
done

# 2. Assemble the staging tree
echo "[2/6] Assembling package staging directory..."
rm -rf "$BUILD_DIR"
mkdir -p "${STAGING_DIR}/DEBIAN"
mkdir -p "${STAGING_DIR}/usr"
mkdir -p "${STAGING_DIR}/etc"
mkdir -p "${STAGING_DIR}/lib"
mkdir -p "${STAGING_DIR}/usr/share/doc/${PACKAGE_NAME}"

# Copy Debian maintainer metadata and scripts
cp -a "${SCRIPT_DIR}/debian/control" "${STAGING_DIR}/DEBIAN/control"
sed -i "s/^Architecture:.*/Architecture: ${PACKAGE_ARCH}/" "${STAGING_DIR}/DEBIAN/control"
[ -f "${SCRIPT_DIR}/debian/postinst" ] && cp -a "${SCRIPT_DIR}/debian/postinst" "${STAGING_DIR}/DEBIAN/postinst"
[ -f "${SCRIPT_DIR}/debian/prerm" ]    && cp -a "${SCRIPT_DIR}/debian/prerm"    "${STAGING_DIR}/DEBIAN/prerm"
[ -f "${SCRIPT_DIR}/debian/postrm" ]   && cp -a "${SCRIPT_DIR}/debian/postrm"   "${STAGING_DIR}/DEBIAN/postrm"

# Copy package documentation
if [ -f "${SCRIPT_DIR}/debian/changelog" ]; then
    gzip -9 -n -c "${SCRIPT_DIR}/debian/changelog" > "${STAGING_DIR}/usr/share/doc/${PACKAGE_NAME}/changelog.Debian.gz"
fi
if [ -f "${SCRIPT_DIR}/LICENSE" ]; then
    cp -a "${SCRIPT_DIR}/LICENSE" "${STAGING_DIR}/usr/share/doc/${PACKAGE_NAME}/copyright"
fi

# Copy usr, etc, lib, and opt trees
cp -r "${SCRIPT_DIR}/usr/"* "${STAGING_DIR}/usr/"
cp -r "${SCRIPT_DIR}/etc/"* "${STAGING_DIR}/etc/"
cp -r "${SCRIPT_DIR}/lib/"* "${STAGING_DIR}/lib/"
if [ -d "${SCRIPT_DIR}/opt" ]; then
    mkdir -p "${STAGING_DIR}/opt"
    cp -r "${SCRIPT_DIR}/opt/"* "${STAGING_DIR}/opt/"
fi

# Verify plugin staging and validate absence of placeholder scopes
if [ ! -f "${STAGING_DIR}/opt/dsh-desktop/plugins/dsh-nvidia-nim-fix/index.js" ]; then
    echo "Error: opt/dsh-desktop/plugins/dsh-nvidia-nim-fix/index.js was not staged." >&2
    exit 1
fi
if grep -Rq 'your-scope' "${STAGING_DIR}/opt/dsh-desktop/plugins/dsh-nvidia-nim-fix/"; then
    echo "Error: placeholder scope found in plugin package.json" >&2
    exit 1
fi

# Smoke test plugin module export in staged tree
node --input-type=module -e "
    const m = await import('${STAGING_DIR}/opt/dsh-desktop/plugins/dsh-nvidia-nim-fix/index.js');
    if (typeof m.apply !== 'function') { console.error('apply missing'); process.exit(1); }
    console.log('plugin smoke OK');
"

if [ ! -f "${STAGING_DIR}/usr/share/mime/packages/dsh-desktop.xml" ]; then
    echo "Error: usr/share/mime/packages/dsh-desktop.xml was not staged." >&2
    exit 1
fi
if [ ! -f "${STAGING_DIR}/usr/share/applications/dsh-desktop-preset.desktop" ]; then
    echo "Error: usr/share/applications/dsh-desktop-preset.desktop was not staged." >&2
    exit 1
fi
if [ ! -f "${STAGING_DIR}/usr/lib/dsh-desktop/bin/dsh-desktop-upgrade-helper" ]; then
    echo "Error: usr/lib/dsh-desktop/bin/dsh-desktop-upgrade-helper was not staged." >&2
    exit 1
fi
if [ ! -f "${STAGING_DIR}/usr/share/polkit-1/actions/io.ridgebridge.dsh-desktop.upgrade.policy" ]; then
    echo "Error: usr/share/polkit-1/actions/io.ridgebridge.dsh-desktop.upgrade.policy was not staged." >&2
    exit 1
fi
if [ ! -f "${STAGING_DIR}/etc/apt/apt.conf.d/51dsh-desktop-unattended-upgrades" ]; then
    echo "Error: etc/apt/apt.conf.d/51dsh-desktop-unattended-upgrades was not staged." >&2
    exit 1
fi

# Validate AppArmor profile syntax at build time.
# Fails the build on parse error when apparmor_parser is present (set -e).
# Silently skipped on hosts without AppArmor (CI, non-AppArmor kernels).
if command -v apparmor_parser >/dev/null 2>&1; then
    apparmor_parser -Q "${SCRIPT_DIR}/etc/apparmor.d/usr.bin.dsh-desktop"
    echo "AppArmor profile parsed OK."
fi


# Vendor the app's bundled production dependencies (exact-pinned pnpm). The
# installer and package runner resolve pnpm from this closure; a user's system
# pnpm is never consulted. Run 'npm ci' before building.
if [ ! -d "${SCRIPT_DIR}/node_modules/pnpm" ] || [ ! -d "${SCRIPT_DIR}/node_modules/fflate" ]; then
    echo "Error: bundled dependencies (pnpm, fflate) are missing. Run 'npm ci' before building." >&2
    exit 1
fi
mkdir -p "${STAGING_DIR}/usr/share/dsh-desktop/node_modules"
cp -a "${SCRIPT_DIR}/node_modules/pnpm" "${STAGING_DIR}/usr/share/dsh-desktop/node_modules/"
cp -a "${SCRIPT_DIR}/node_modules/fflate" "${STAGING_DIR}/usr/share/dsh-desktop/node_modules/"

# 3. Set correct permissions
echo "[3/6] Setting standard file and directory permissions..."
# All directories: 0755
find "$STAGING_DIR" -type d -exec chmod 0755 {} +

# All data files: 0644
find "$STAGING_DIR" -type f -exec chmod 0644 {} +

# Executable binaries and scripts: 0755
chmod 0755 "${STAGING_DIR}/usr/lib/dsh-desktop/bin/dsh-desktop"
chmod 0755 "${STAGING_DIR}/usr/lib/dsh-desktop/bin/dsh-desktop-daemon"
chmod 0755 "${STAGING_DIR}/usr/lib/dsh-desktop/bin/dsh-desktop-upgrade-helper"

# Maintainer scripts in DEBIAN: 0755
[ -f "${STAGING_DIR}/DEBIAN/postinst" ] && chmod 0755 "${STAGING_DIR}/DEBIAN/postinst"
[ -f "${STAGING_DIR}/DEBIAN/prerm" ]    && chmod 0755 "${STAGING_DIR}/DEBIAN/prerm"
[ -f "${STAGING_DIR}/DEBIAN/postrm" ]   && chmod 0755 "${STAGING_DIR}/DEBIAN/postrm"

# 4. Build the Debian package
echo "[4/6] Building Debian archive..."
DPKG_DEB_CMD=()
if [ "${DSH_BUILD_EATMYDATA:-1}" != "0" ]; then
    if command -v eatmydata >/dev/null 2>&1; then
        DPKG_DEB_CMD=(eatmydata)
    else
        echo "Notice: eatmydata not found. Building without eatmydata wrapper."
    fi
fi

ARCHIVE_TARGET="$DEB_FILE"
if [ "$USE_TMPFS" -eq 1 ]; then
    ARCHIVE_TARGET="$TMPFS_DEB_FILE"
fi

if [ "$HAS_FAKEROOT" -eq 1 ]; then
    "${DPKG_DEB_CMD[@]}" fakeroot dpkg-deb --build "$STAGING_DIR" "$ARCHIVE_TARGET"
else
    "${DPKG_DEB_CMD[@]}" dpkg-deb --root-owner-group --build "$STAGING_DIR" "$ARCHIVE_TARGET"
fi

if [ "$USE_TMPFS" -eq 1 ]; then
    rsync -a "$TMPFS_DEB_FILE" "$DEB_FILE"
fi

# 5. Run lintian if available
echo "[5/6] Running lintian validation..."
if [ "$HAS_LINTIAN" -eq 1 ]; then
    lintian --fail-on error --no-tag-display-limit "$DEB_FILE"
else
    echo "Notice: lintian skipped (not installed)."
fi

# 6. Print resulting package info and sha256
echo "[6/6] Build complete!"
echo "Package File: $DEB_FILE"
echo "Package Size: $(du -h "$DEB_FILE" | cut -f1)"
echo -n "SHA256: "
sha256sum "$DEB_FILE" | cut -d' ' -f1
