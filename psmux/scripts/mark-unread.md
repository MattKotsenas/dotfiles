# Unread reminder pane

Press **prefix, Shift+n** to toggle a three-row reminder pane below the current pane. The application keeps focus. The reminder emits its own OSC 7501 `done` result, which participates in the existing window-tab status indicators. Blocked work and unseen errors take priority over the reminder.

Returning to the application leaves the reminder unread. Press the binding again in that window to dismiss it. Selecting the reminder pane acknowledges its result; the binding still removes it.

A PowerShell process sleeps in the reminder pane until dismissal. The script does not change `remain-on-exit` or write into the application's console. Closing the reminder with the usual pane-close command also dismisses it.

The binding passes the pane id and socket path explicitly so the helper targets the originating server even if inherited terminal variables refer elsewhere. Keep both arguments when invoking the script manually.

Run the isolated integration tests with:

```powershell
pwsh -NoProfile -File psmux/scripts/unread.Tests.ps1
```
