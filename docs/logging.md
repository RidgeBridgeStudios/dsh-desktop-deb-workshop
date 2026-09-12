# Logging and Diagnostics

DSH Desktop manages daemon logging via `systemd` user journaling, eliminating unbounded log file growth while retaining structured diagnostics.

## Systemd User Journal (Primary)

The systemd user service (`dsh-desktop.service`) routes output to the systemd journal with identifier `SyslogIdentifier=dsh-desktop`.

### Live Stream Logs
Follow real-time daemon output:
```bash
journalctl --user -u dsh-desktop.service -f
```

Filter directly by syslog identifier:
```bash
journalctl --user -t dsh-desktop -f
```

### View Recent Logs
Inspect the last 100 log entries:
```bash
journalctl --user -u dsh-desktop.service -n 100 --no-pager
```

### Current Boot Logs
View all logs since the last system boot:
```bash
journalctl --user -u dsh-desktop.service -b
```

### Inspect Service Status
Check health and active state of the background unit:
```bash
systemctl --user status dsh-desktop.service
```

---

## Direct Daemon / Fallback Log File

When `dsh-desktop` runs outside of systemd (e.g. standalone execution fallback when systemd user session is unavailable), stdout and stderr are appended to:

```
~/.local/share/dsh-desktop/dsh.log
```

To tail this file if standalone fallback was triggered:
```bash
tail -f ~/.local/share/dsh-desktop/dsh.log
```
