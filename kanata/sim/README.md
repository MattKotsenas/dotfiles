# kanata simulated input

`kanata_simulated_input.exe` is built from a patched fork of kanata
([MattKotsenas/kanata](https://github.com/MattKotsenas/kanata),
branch `dotfiles/sim-pushmsg-log`).

## Why patched

Upstream `simulated_input` drops `push-msg` payloads when the TCP server
is off (which it always is in the simulator). The patch adds an `INFO`
log of the message text so tests can observe push-msg actions.

The patch also removes a stray `println!("{}", 42)` that polluted stdout
on every tick.

## Used by

The C# test harness in
[`komorebi/event-listeners/EventListeners.Tests/KanataHarness`](../../komorebi/event-listeners/EventListeners.Tests/KanataHarness)
spawns this binary to verify kanata config behavior.

## Rebuilding

```pwsh
git clone https://github.com/MattKotsenas/kanata.git C:\Projects\kanata
cd C:\Projects\kanata
git checkout dotfiles/sim-pushmsg-log
cd simulated_input
cargo build --release
Copy-Item ..\target\release\kanata_simulated_input.exe C:\Projects\dotfiles\kanata\sim\
```

## Upstream

The patch is intentionally minimal and useful for anyone testing kanata
configs that use `push-msg`. An upstream PR is planned (TODO).
