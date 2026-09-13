# Manual Verification Guide: DSH NVIDIA NIM Fix Plugin

This guide provides steps to install and verify the `@dsh-desktop/dsh-nvidia-nim-fix` plugin on a target system.

---

## 1. Install the Debian Package

Run the installation with root privileges:

```bash
sudo dpkg -i dsh-desktop_1.1.0_amd64.deb
```

Verify that the plugin files were installed to `/opt/dsh-desktop/plugins/dsh-nvidia-nim-fix`:

```bash
ls -la /opt/dsh-desktop/plugins/dsh-nvidia-nim-fix/
```

Expected output includes `index.js`, `index.d.ts`, `package.json`, and `src/index.ts`.

---

## 2. Verify Post-Install Cordis Patch

Check that `debian/postinst` inserted the patch reference into your user profile:

```bash
grep -A 2 "dsh-nvidia-nim-fix" ~/.dsh/cordis.patch.yml ~/.dsh/profiles/default/cordis.patch.yml
```

Expected output:
```yaml
- insert:
  - id: dsh-nvidia-nim-fix
    name: /opt/dsh-desktop/plugins/dsh-nvidia-nim-fix/index.js
```

---

## 3. Restart the DSH Desktop Service

If running as a user systemd service:

```bash
systemctl --user daemon-reload
systemctl --user restart dsh-desktop.service
systemctl --user status dsh-desktop.service
```

*Note: If an existing background Node instance is running on port 3080, terminate it before restarting.*

---

## 4. End-to-End Live Verification with NVIDIA NIM

1. Ensure your NVIDIA NIM API key is configured in `~/.dsh/.credentials.yaml`:
   ```yaml
   NVIDIA_API_KEY: nvapi-...
   ```
2. Launch DSH Desktop or invoke a DeepSeek-v4 model stream (e.g. `deepseek-ai/deepseek-v4-flash-0731`).
3. Enable debug logging if desired:
   ```bash
   DSH_DEBUG=1 /usr/bin/dsh-desktop
   ```
4. Confirm:
   - The model streams reasoning tokens immediately without hanging on "thinking".
   - Outbound requests to `https://integrate.api.nvidia.com/v1/chat/completions` include:
     ```json
     "chat_template_kwargs": { "thinking": true, "reasoning_effort": "high" }
     ```
   - Outbound requests do **not** contain `"thinking": {"type": "disabled"}`.
