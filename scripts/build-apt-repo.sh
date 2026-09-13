#!/usr/bin/env bash
set -euo pipefail

# scripts/build-apt-repo.sh: Generate signed Debian apt repository metadata
# Usage: ./scripts/build-apt-repo.sh <deb_directory> [output_repo_directory]

if [ $# -lt 1 ]; then
    echo "Usage: $0 <deb_directory> [output_repo_directory]" >&2
    exit 1
fi

DEB_DIR="$(cd "$1" && pwd)"
REPO_DIR="${2:-.}"
mkdir -p "$REPO_DIR"
REPO_DIR="$(cd "$REPO_DIR" && pwd)"

if [ -z "${DSH_APT_GPG_KEY:-}" ]; then
    echo "Error: DSH_APT_GPG_KEY environment variable is required to sign repository." >&2
    exit 1
fi

if ! command -v apt-ftparchive >/dev/null 2>&1; then
    echo "Error: apt-ftparchive is required but not installed." >&2
    exit 1
fi

if ! command -v gpg >/dev/null 2>&1; then
    echo "Error: gpg is required but not installed." >&2
    exit 1
fi

DIST_DIR="${REPO_DIR}/dists/stable"
POOL_DIR="${REPO_DIR}/pool/main"
mkdir -p "$POOL_DIR"

# Stage deb files into pool/main if source directory differs
if [ "$DEB_DIR" != "$POOL_DIR" ]; then
    find "$DEB_DIR" -maxdepth 1 -name "*.deb" -exec cp -u {} "$POOL_DIR/" \;
fi

# Generate Packages and Packages.gz for both amd64 and arm64
ARCHS=("amd64" "arm64")
for arch in "${ARCHS[@]}"; do
    BINARY_DIR="${DIST_DIR}/main/binary-${arch}"
    mkdir -p "$BINARY_DIR"
    PACKAGES_FILE="${BINARY_DIR}/Packages"

    # apt-ftparchive scans pool/main relative to REPO_DIR
    (
        cd "$REPO_DIR"
        apt-ftparchive -a "$arch" packages pool/main > "$PACKAGES_FILE"
    )

    gzip -9 -c "$PACKAGES_FILE" > "${PACKAGES_FILE}.gz"
done

# Generate Release file
RELEASE_FILE="${DIST_DIR}/Release"
(
    cd "$REPO_DIR"
    apt-ftparchive         -o APT::FTPArchive::Release::Origin="RidgeBridgeStudios"         -o APT::FTPArchive::Release::Label="DSH Desktop"         -o APT::FTPArchive::Release::Suite="stable"         -o APT::FTPArchive::Release::Codename="stable"         -o APT::FTPArchive::Release::Architectures="amd64 arm64"         -o APT::FTPArchive::Release::Components="main"         release dists/stable > "$RELEASE_FILE"
)

# Sign Release file: detached signature (Release.gpg) and inline signature (InRelease)
gpg --batch --yes --armor --detach-sign --local-user "$DSH_APT_GPG_KEY"     -o "${DIST_DIR}/Release.gpg" "$RELEASE_FILE"

gpg --batch --yes --clearsign --local-user "$DSH_APT_GPG_KEY"     -o "${DIST_DIR}/InRelease" "$RELEASE_FILE"

echo "APT repository built successfully at ${REPO_DIR}:"
echo "  dists/stable/{Release,InRelease,Release.gpg}"
echo "  dists/stable/main/binary-{amd64,arm64}/Packages{,.gz}"
