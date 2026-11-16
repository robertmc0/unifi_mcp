# Example: a TLS reverse proxy in front of the MCP listener

> **Not tested by this project.** The requirements below are what the service needs
> (they are tested from the service's side, see `docs/networking.md`). The nginx
> configuration is an illustration of them and has not been run against the service.
> For HTTPS without a proxy, use `deploy/compose.tls.yml`, which is tested.

Use a proxy when you already run one for certificates. Keep the service on the host's
loopback (`deploy/compose.single.yml` publishes `127.0.0.1:3000`), and let the proxy be
the only thing that listens on the network.

## What the proxy must do

| Requirement                                         | Why                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Terminate TLS with a certificate clients trust      | Client tokens must not cross a network in plaintext.                                           |
| Pass `Authorization` unchanged                      | It carries the client token.                                                                   |
| Pass the `Host` clients used                        | The service accepts only names in `UNIFI_MCP_HTTP_ALLOWED_HOSTS` (add your public name there). |
| Not buffer responses; allow them to stay open       | Event subscriptions are `text/event-stream` responses that stay open for up to an hour.        |
| Forward only `/mcp` (and `/readyz` if you probe it) | Nothing else is meant for clients.                                                             |
| Not cache                                           | Results are per client. The service sends `Cache-Control: no-store`.                           |
| Reach the service on loopback only                  | The proxy's hop is plaintext. On another machine it would need its own protection.             |

The service never trusts `X-Forwarded-*` headers. Behind a proxy, its
failed-authentication throttle sees the proxy's address for every client, so one client's
wrong tokens can slow sign-in for all. Rate-limit by client address in the proxy if that
matters to you.

Do not put the admin interface or the metrics listener behind the same public name.

## nginx illustration

```nginx
server {
    listen 443 ssl;
    server_name mcp.example.lan;

    ssl_certificate     /etc/ssl/mcp.example.lan/fullchain.pem;
    ssl_certificate_key /etc/ssl/mcp.example.lan/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    location = /mcp {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3700s;
        client_max_body_size 1m;
    }

    location / {
        return 404;
    }
}
```

With this, set `UNIFI_MCP_HTTP_ALLOWED_HOSTS=mcp.example.lan` for the service. It keeps
`UNIFI_MCP_HTTP_BIND=0.0.0.0` and `UNIFI_MCP_HTTP_ALLOW_PLAINTEXT=true` inside its
container, as `compose.single.yml` sets them: the port is published on the host's
loopback, which is what protects the plaintext hop.

## Check it

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://mcp.example.lan/mcp      # 401: reachable, wants a token
curl -sS -o /dev/null -w '%{http_code}\n' https://mcp.example.lan/livez    # 404: not forwarded
```

Then connect a client ([docs/client-generic-mcp.md](../docs/client-generic-mcp.md)) and
subscribe to an event stream for a few minutes, to see that the proxy keeps it open.
