# kanata simulated input

`kanata_simulated_input.exe` is built from a patched fork of kanata
([MattKotsenas/kanata](https://github.com/MattKotsenas/kanata),
branch `dotfiles/sim-pushmsg-log`, off the `v1.11.0` tag).

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

If the binary is lost or kanata is bumped to a newer version, rebuild:

```pwsh
git clone https://github.com/jtroo/kanata.git C:\Projects\kanata
cd C:\Projects\kanata
git checkout v1.11.0
git apply C:\Projects\dotfiles\kanata\sim\dotfiles-sim-pushmsg-log.patch
cd simulated_input
cargo build --release
Copy-Item ..\target\release\kanata_simulated_input.exe C:\Projects\dotfiles\kanata\sim\
```

The patch file `dotfiles-sim-pushmsg-log.patch` lives next to this README.
It's also maintained on the MattKotsenas/kanata fork, branch
`dotfiles/sim-pushmsg-log` — if that branch still exists you can
`git checkout` it and skip `git apply`.

## The patch

If the fork is gone, apply this diff manually:

```diff
diff --git a/simulated_input/src/sim.rs b/simulated_input/src/sim.rs
@@ -212,10 +212,7 @@ fn kbd_out_log(
     _key_code: Option<OsCode>,
     _tick: Option<u128>,
 ) {
-    let a = LogFmtT::InTick;
-    if a == LogFmtT::InTick {
-        println!("{}", 42)
-    };
+    // dotfiles patch: removed `println!("{}", 42)` debug noise
     #[cfg(all(
         not(feature = "simulated_input"),
         not(feature = "passthru_ahk"),

diff --git a/src/kanata/mod.rs b/src/kanata/mod.rs
@@ -1613,6 +1613,11 @@ impl Kanata {
                         }
                         CustomAction::PushMessage(_message) => {
                             log::debug!("Action push-msg");
+                            // dotfiles patch: log the message text at INFO regardless of TCP server state
+                            // so simulated_input can observe push-msg actions for testing.
+                            // Upstream uses simple_sexpr_to_json_array but that's behind tcp_server feature.
+                            // Use Debug formatting which works for any _message type.
+                            log::info!("push-msg: {:?}", _message);
                             #[cfg(feature = "tcp_server")]
                             if let Some(tx) = _tx {
                                 let message = simple_sexpr_to_json_array(_message);
```

Save as `dotfiles-sim-pushmsg-log.patch` and apply with `git apply`.

The patched output adds INFO-level lines that the C# harness parses:

```
[INFO] push-msg: [Atom("wm.focus.right")]
```

## Upstream

The patch is intentionally minimal and useful for anyone testing kanata
configs that use `push-msg`. An upstream PR is planned (TODO).

