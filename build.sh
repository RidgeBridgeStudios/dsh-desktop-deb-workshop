#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_NAME="dsh-desktop"
PACKAGE_VERSION="1.0.0"
PACKAGE_ARCH="$(dpkg-architecture -qDEB_HOST_ARCH)"
PACKAGE_FULLNAME="${PACKAGE_NAME}_${PACKAGE_VERSION}_${PACKAGE_ARCH}"
DEB_FILE="${SCRIPT_DIR}/${PACKAGE_FULLNAME}.deb"
BUILD_DIR="${SCRIPT_DIR}/build"
STAGING_DIR="${BUILD_DIR}/${PACKAGE_FULLNAME}"

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
convert -background none -resize 128x128 "${SCRIPT_DIR}/usr/share/dsh-desktop/logo.svg" "${SCRIPT_DIR}/usr/share/icons/hicolor/128x128/apps/dsh-desktop.png"
convert -background none -resize 24x24 "${SCRIPT_DIR}/usr/share/dsh-desktop/logo.svg" "${SCRIPT_DIR}/usr/share/dsh-desktop/tray-icon.png"
convert -background none -resize 24x24 "${SCRIPT_DIR}/usr/share/dsh-desktop/logo.svg" "${SCRIPT_DIR}/usr/share/icons/hicolor/24x24/apps/dsh-desktop.png"

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

# Copy usr, etc, and lib trees
cp -r "${SCRIPT_DIR}/usr/"* "${STAGING_DIR}/usr/"
cp -r "${SCRIPT_DIR}/etc/"* "${STAGING_DIR}/etc/"
cp -r "${SCRIPT_DIR}/lib/"* "${STAGING_DIR}/lib/"

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
chmod 0755 "${STAGING_DIR}/usr/local/bin/dsh-desktop"
chmod 0755 "${STAGING_DIR}/usr/local/bin/dsh-desktop-daemon"

# Maintainer scripts in DEBIAN: 0755
[ -f "${STAGING_DIR}/DEBIAN/postinst" ] && chmod 0755 "${STAGING_DIR}/DEBIAN/postinst"
[ -f "${STAGING_DIR}/DEBIAN/prerm" ]    && chmod 0755 "${STAGING_DIR}/DEBIAN/prerm"
[ -f "${STAGING_DIR}/DEBIAN/postrm" ]   && chmod 0755 "${STAGING_DIR}/DEBIAN/postrm"

# 4. Build the Debian package
echo "[4/6] Building Debian archive..."
if [ "$HAS_FAKEROOT" -eq 1 ]; then
    fakeroot dpkg-deb --build "$STAGING_DIR" "$DEB_FILE"
else
    dpkg-deb --root-owner-group --build "$STAGING_DIR" "$DEB_FILE"
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
