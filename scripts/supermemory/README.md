# Self-hosted Supermemory helpers (Linux)

For the optional long-term memory feature. The setup itself is in
[docs/INSTALL.md](../../docs/INSTALL.md#long-term-memory-optional).

`supermemory-server` (v0.0.8) listens on `0.0.0.0`, with no setting to change it,
and treats every request whose `Host` is localhost as authenticated. If this
machine is reachable from a network, the memory API is too.

- `bind-loopback.c` is an `LD_PRELOAD` shim. It rewrites a wildcard `bind()` on a
  TCP socket to `127.0.0.1` / `::1`, and leaves UDP alone (a DNS resolver may
  bind `0.0.0.0:0`). It needs no root and no firewall change.
- `run-loopback.sh` starts the server from a clean environment with the shim
  loaded. The server reads `PORT` before `SUPERMEMORY_PORT`, so inheriting
  PlumiChat's `PORT` would make the two fight over one port.

```sh
gcc -O2 -Wall -shared -fPIC -o scripts/supermemory/bind-loopback.so scripts/supermemory/bind-loopback.c -ldl
scripts/supermemory/run-loopback.sh ~/.supermemory/env      # or under pm2 / systemd
ss -ltnp | grep 6767                                        # must show 127.0.0.1:6767
```

macOS has no equivalent here. `DYLD_INSERT_LIBRARIES` is ignored for hardened
binaries, so keep the port closed with the firewall instead.
