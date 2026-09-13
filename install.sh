#!/usr/bin/env bash
# WARNING: This script is intended to be run via curl | bash.
# Always inspect third-party scripts before executing them with elevated privileges.
set -euo pipefail

REPO="RidgeBridgeStudios/dsh-desktop-deb-workshop"
VERSION="1.0.0"

echo "======================================================"
echo "    DeepSeek Harness Desktop (dsh-desktop) Installer  "
echo "======================================================"

# 1. Detect Ubuntu / Zorin OS
echo "[1/6] Detecting operating system..."
if [ ! -f /etc/os-release ]; then
    echo "Error: /etc/os-release not found. This installer supports Ubuntu and Zorin OS." >&2
    exit 1
fi

# shellcheck source=/dev/null
source /etc/os-release
OS_ID="${ID:-}"
OS_LIKE="${ID_LIKE:-}"

if [[ "$OS_ID" != "ubuntu" && "$OS_ID" != "zorin" && "$OS_LIKE" != *"ubuntu"* ]]; then
    echo "Warning: Target OS ($OS_ID) may not be Ubuntu or Zorin OS. Proceeding anyway..."
else
    echo "Detected supported OS: ${PRETTY_NAME:-$OS_ID}"
fi

DEB_ARCH="$(dpkg-architecture -qDEB_HOST_ARCH 2>/dev/null || echo amd64)"
DEB_NAME="dsh-desktop_${VERSION}_${DEB_ARCH}.deb"

# 2. Verify / Install Node.js 22 LTS if node -v is below 20.12
echo "[2/6] Checking Node.js version..."
NEED_NODE_INSTALL=1

if command -v node >/dev/null 2>&1; then
    NODE_RAW=$(node -v 2>/dev/null | sed 's/^v//')
    NODE_MAJOR=$(echo "$NODE_RAW" | cut -d. -f1)
    NODE_MINOR=$(echo "$NODE_RAW" | cut -d. -f2)
    echo "Found existing Node.js v${NODE_RAW}"

    if [ "$NODE_MAJOR" -gt 20 ] || { [ "$NODE_MAJOR" -eq 20 ] && [ "$NODE_MINOR" -ge 12 ]; }; then
        echo "Node.js v${NODE_RAW} meets requirement (>= 20.12)."
        NEED_NODE_INSTALL=0
    else
        echo "Node.js v${NODE_RAW} is below 20.12. Upgrading to Node 22 LTS..."
    fi
else
    echo "Node.js is not installed. Installing Node 22 LTS..."
fi

if [ "$NEED_NODE_INSTALL" -eq 1 ]; then
    echo "Adding NodeSource repository for Node.js 22 LTS..."
    sudo apt-get update -y
    sudo apt-get install -y ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    echo "Node.js installed successfully: $(node -v)"
fi

# 3. Install pnpm, electron, and @deepseek-ai/dsh globally
# Pinned to supported DSH version matching usr/share/dsh-desktop/lib/plugin-manager/dsh-version.mjs
SUPPORTED_DSH_VERSION="0.1.5-rc.1"
echo "[3/6] Installing pnpm, electron, and @deepseek-ai/dsh@${SUPPORTED_DSH_VERSION} globally..."
sudo npm install -g pnpm electron "@deepseek-ai/dsh@${SUPPORTED_DSH_VERSION}"

# 4. Install prebuilt sharp and native platform binaries globally
echo "[4/6] Installing prebuilt native sharp binaries..."
if ! command -v dpkg-architecture >/dev/null 2>&1; then
  echo "Error: dpkg-architecture is required. Install with: sudo apt install -y dpkg-dev" >&2
  exit 1
fi
ARCH="$(dpkg-architecture -qDEB_HOST_ARCH 2>/dev/null || echo amd64)"
case "$ARCH" in
  amd64) SHARP_PKG="@img/sharp-linux-x64" ;;
  arm64) SHARP_PKG="@img/sharp-linux-arm64" ;;
  *) echo "Unsupported arch $ARCH for sharp" >&2; exit 1 ;;
esac
sudo npm install -g --os=linux --cpu="$([ "$ARCH" = amd64 ] && echo x64 || echo arm64)" sharp "$SHARP_PKG"

# 5. Download the latest dsh-desktop .deb package
echo "[5/6] Fetching dsh-desktop Debian package..."
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

DEB_DEST="${WORK_DIR}/${DEB_NAME}"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download/v${VERSION}/${DEB_NAME}"

verify_sha() {
    local target_file="$1"
    echo "Verifying package checksum (SHA256)..."
    local actual_sha
    actual_sha=$(sha256sum "$target_file" | cut -d' ' -f1)

    local expected_sha=""
    if curl -sLf "${DOWNLOAD_URL}.sha256" -o "${WORK_DIR}/${DEB_NAME}.sha256" 2>/dev/null; then
        expected_sha=$(awk '{print $1}' "${WORK_DIR}/${DEB_NAME}.sha256" | head -n 1)
    fi

    if [ -z "$expected_sha" ]; then
        local release_json
        release_json=$(curl -s "https://api.github.com/repos/${REPO}/releases/tags/v${VERSION}" 2>/dev/null || true)
        if [ -n "$release_json" ]; then
            expected_sha=$(echo "$release_json" | grep -oE '"digest":\s*"sha256:[a-f0-9]{64}"' | cut -d: -f3 | tr -d '"' | head -n 1 || true)
            if [ -z "$expected_sha" ]; then
                expected_sha=$(echo "$release_json" | grep -E "$DEB_NAME" | grep -oE '[a-f0-9]{64}' | head -n 1 || true)
            fi
        fi
    fi

    if [ -z "$expected_sha" ] && [ "$VERSION" = "1.0.0" ]; then
        expected_sha="9f7f96fecdb69e440177aaf0ebeecbf1eb18ec5ff47de2867c26ac8f346dbb51"
    fi

    if [ -n "$expected_sha" ]; then
        if [ "$actual_sha" != "$expected_sha" ]; then
            echo "Error: SHA256 checksum verification failed for ${DEB_NAME}!" >&2
            echo "  Expected: ${expected_sha}" >&2
            echo "  Actual:   ${actual_sha}" >&2
            exit 1
        fi
        echo "SHA256 checksum verified: ${actual_sha}"
    else
        echo "Error: Could not retrieve expected SHA256 checksum for verification." >&2
        exit 1
    fi
}

# Check if local package exists first (for local workspace installs)
if [ -f "./${DEB_NAME}" ]; then
    echo "Using local package: ./${DEB_NAME}"
    cp "./${DEB_NAME}" "$DEB_DEST"
    verify_sha "$DEB_DEST"
else
    # Try fetching latest release from GitHub Releases
    echo "Downloading from: $DOWNLOAD_URL"
    if ! curl -fL --progress-bar -o "$DEB_DEST" "$DOWNLOAD_URL"; then
        echo "Direct release download failed, attempting GitHub API lookup..."
        LATEST_URL=$(curl -s "https://api.github.com/repos/${REPO}/releases/latest" | grep "browser_download_url.*${DEB_ARCH}\.deb" | cut -d '"' -f 4 | head -n 1 || true)
        if [ -n "$LATEST_URL" ]; then
            curl -fL --progress-bar -o "$DEB_DEST" "$LATEST_URL"
        else
            echo "Error: Could not download ${DEB_NAME} from GitHub releases." >&2
            echo "You can build it manually using ./build.sh and install with: sudo apt install ./${DEB_NAME}" >&2
            exit 1
        fi
    fi
    verify_sha "$DEB_DEST"
fi

# 6. Install package with apt
echo "[6/6] Installing dsh-desktop package..."
sudo apt-get update -y
sudo apt-get install -y "$DEB_DEST"

echo ""
echo "======================================================"
echo "    DSH Desktop has been installed successfully!     "
echo "======================================================"
echo ""
echo "You can launch DSH Desktop by:"
echo "  1. Searching for 'DSH Desktop' in your application menu"
echo "  2. Running 'dsh-desktop' from your terminal"
echo ""
echo "Systemd service status: systemctl --user status dsh-desktop.service"
echo "Logs: tail -f ~/.local/share/dsh-desktop/dsh.log"
