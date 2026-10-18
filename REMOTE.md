# Remote access

Run the F5 server on one machine and open it from another device, such as a phone, tablet or
another laptop.

## How to

1. Build the web app: `bun run build`.
2. Generate a token: `TOKEN="$(openssl rand -hex 24)"`.
3. Start the server on a reachable address:

   ```bash
   bun run --cwd apps/server start -- --host 0.0.0.0 --port 3773 --auth-token "$TOKEN" --no-browser
   ```

4. On the other device, open `http://<your-machine-ip>:3773/#token=<token>`. Get the token with
   `printf '%s\n' "$TOKEN"`.
5. Make sure your firewall allows inbound TCP on that port.

Remote access needs the built web app, not Vite dev-server mode.

> [!IMPORTANT]
> F5 listens on `127.0.0.1` by default and refuses any other address without `--auth-token`.
> Older setups that relied on binding to every interface must now set `--host` and a token.

## Tailscale

Bind to your Tailnet address so only devices on your tailnet can connect:

```bash
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host "$(tailscale ip -4)" --port 3773 --auth-token "$TOKEN" --no-browser
```

Then open `http://<tailnet-ip>:3773/#token=<token>` from any device on the tailnet.

## Multiple profiles

Each [profile](docs/profiles.md) runs on its own port and browser origin. Expose each port, pass the
same `--auth-token` to each server, and open the `#token=` link once per origin. If you override
ports, keeping origins separate is up to you.

## Good to know

> [!WARNING]
> F5 doesn't provide TLS. Over plain LAN HTTP, the token and session cookie travel in cleartext.
> Use an encrypted network such as Tailscale, or an HTTPS/WSS reverse proxy.

- Tokens must be at least 24 bytes. Generate one; don't use a password.
- Bind to a trusted interface (LAN or Tailnet IP) rather than `0.0.0.0` when you can.
- Reverse proxies should keep the original `Host` header and set `X-Forwarded-Proto: https`, so F5
  marks the session cookie `Secure`.

<details>
<summary>Details and limits</summary>

**Options.** Every option can be set as a CLI flag or an environment variable. Run with `--help`
for the full list.

| CLI flag                | Env var               | Notes                              |
| ----------------------- | --------------------- | ---------------------------------- |
| `--mode <web\|desktop>` | `T3CODE_MODE`         | Runtime mode.                      |
| `--port <number>`       | `T3CODE_PORT`         | HTTP/WebSocket port.               |
| `--host <address>`      | `T3CODE_HOST`         | Bind interface/address.            |
| `--home-dir <path>`     | `F5_HOME`             | Base directory for F5 state.       |
| `--state-dir <path>`    | `F5_STATE_DIR`        | State directory.                   |
| `--dev-url <url>`       | `VITE_DEV_SERVER_URL` | Dev web URL redirect/proxy target. |
| `--no-browser`          | `T3CODE_NO_BROWSER`   | Disable auto-open browser.         |
| `--auth-token <token>`  | `T3CODE_AUTH_TOKEN`   | Remote HTTP and WebSocket token.   |

The older `T3CODE_HOME` and `T3CODE_STATE_DIR` still work, but `F5_HOME` and `F5_STATE_DIR` win
when both are set.

**Token exchange.** The token is passed once in the URL fragment, which is never sent in HTTP
requests or WebSocket URLs. The browser trades it for a short-lived HttpOnly session cookie and
removes it from the address bar.

**Other clients.** Non-browser WebSocket clients authenticate with
`Authorization: Bearer <token>`. The older `?token=` form is accepted only from loopback, for the
desktop app.

</details>

## Related

- [Environment variables](docs/environment.md)
- [Profiles](docs/profiles.md)
- [Standalone CLI](docs/user/standalone-cli.md)
