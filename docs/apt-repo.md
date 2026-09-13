# APT Repository Operations & Distribution

This document details the Debian APT repository layout, GPG signing key management, rotation procedures, and user installation instructions for DSH Desktop.

## Hosting Layout

The repository is hosted statically at `https://apt.ridgebridge.io/` with standard Debian pool and dists hierarchies:

```
/
├── dists/
│   └── stable/
│       ├── InRelease          # Clearsigned repository metadata
│       ├── Release            # Unsigned repository metadata
│       ├── Release.gpg        # Detached GPG signature for Release
│       └── main/
│           ├── binary-amd64/
│           │   ├── Packages   # Package index (amd64)
│           │   └── Packages.gz
│           └── binary-arm64/
│               ├── Packages   # Package index (arm64)
│               └── Packages.gz
└── pool/
    └── main/
        ├── dsh-desktop_<version>_amd64.deb
        └── dsh-desktop_<version>_arm64.deb
```

## Key Generation

Create an RSA 4096-bit signing key dedicated to the APT archive:

```bash
# Generate key pair
gpg --batch --gen-key <<EOF
Key-Type: RSA
Key-Length: 4096
Subkey-Type: RSA
Subkey-Length: 4096
Name-Real: RidgeBridgeStudios APT Signing Key
Name-Email: apt@ridgebridge.io
Expire-Date: 2y
%no-protection
%commit
EOF

# Export public keyring in binary format for APT
gpg --armor --export apt@ridgebridge.io | gpg --dearmor -o dsh-desktop.gpg
```

Publish `dsh-desktop.gpg` to `https://apt.ridgebridge.io/dsh-desktop.gpg`.

## Key Rotation

1. **Generate New Key**: Generate key with a future expiration date.
2. **Dual-Sign Period**: Before retiring the old key, add the new public key alongside the old key in user instructions or package postinst. Sign `Release` with the new key ID using `DSH_APT_GPG_KEY=<new-key-fingerprint> ./scripts/build-apt-repo.sh`.
3. **Revocation**: Once clients have received the updated keyring, revoke the old key using a pre-generated revocation certificate:
   ```bash
   gpg --output revoke.asc --gen-revoke apt@ridgebridge.io
   gpg --import revoke.asc
   ```

## User Repository Configuration

Users configure the repository on Debian / Ubuntu systems with:

```bash
# 1. Download and install public keyring
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://apt.ridgebridge.io/dsh-desktop.gpg | sudo tee /etc/apt/keyrings/dsh-desktop.gpg >/dev/null

# 2. Add repository source list
echo "deb [arch=amd64,arm64 signed-by=/etc/apt/keyrings/dsh-desktop.gpg] https://apt.ridgebridge.io/ stable main" |   sudo tee /etc/apt/sources.list.d/dsh-desktop.list >/dev/null

# 3. Update index and install
sudo apt update
sudo apt install -y dsh-desktop
```

The exact repository source line is:
```
deb [arch=amd64,arm64 signed-by=/etc/apt/keyrings/dsh-desktop.gpg] https://apt.ridgebridge.io/ stable main
```
