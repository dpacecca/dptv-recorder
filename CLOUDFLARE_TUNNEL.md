# Exposing DPTV Recorder via Cloudflare Tunnel

Cloudflare Tunnel terminates public HTTPS at Cloudflare's edge and reaches
your container through an outbound, already-encrypted tunnel connection -
**the app itself doesn't need to natively serve HTTPS for this to be secure
end-to-end.** You still get a real `https://` URL for browsers; DPTV
Recorder just needs to behave correctly while sitting behind that tunnel,
which this version handles automatically (see below).

## 1. Set up the tunnel

If you don't already have `cloudflared` running (e.g. as its own container,
or the Unraid Community Applications "Cloudflare Tunnel" app):

```bash
cloudflared tunnel login
cloudflared tunnel create dptv-recorder
```

Point it at the container. If cloudflared runs on the same Docker network as
this app, use the container/service name (`dptv-recorder`); if not, use the
host's LAN IP:

```yaml
# cloudflared config.yml
tunnel: <your-tunnel-id>
credentials-file: /path/to/credentials.json

ingress:
  - hostname: dptv.yourdomain.com
    service: http://dptv-recorder:3000   # plain http - the tunnel handles TLS
  - service: http_status:404
```

Then route DNS (this creates the proxied/orange-cloud CNAME automatically):

```bash
cloudflared tunnel route dns dptv-recorder dptv.yourdomain.com
```

## 2. Tell DPTV Recorder it's behind HTTPS

Set this in `.env`:

```bash
COOKIE_SECURE=true
```

Rebuild/restart. This is the only setting you need to change - `trust
proxy` (so the app correctly recognizes forwarded-HTTPS requests) is already
handled internally, no configuration needed.

**Only set `COOKIE_SECURE=true` if you *exclusively* access the app over
HTTPS from now on.** If you also want to hit it directly over plain
`http://192.168.x.x:3000` on your LAN, leave it `false` - browsers refuse to
send a `Secure` cookie over an insecure connection, so login would silently
fail to persist on the plain-HTTP path if you turn this on while still using
LAN HTTP access too. If you want both, put your own reverse proxy /
Cloudflare Tunnel in front of LAN access as well, or just accept staying
logged out on the LAN URL.

## 3. If you're also using Authentik SSO through the tunnel

Set the OIDC redirect URI (Settings → Admin, admin accounts only) to the
public HTTPS URL:

```
https://dptv.yourdomain.com/api/auth/oidc/callback
```

This must match **exactly** what's registered in Authentik's provider
config, protocol included.

## Notes

- Recording and ffmpeg operations happen entirely server-side against
  `127.0.0.1` - none of that traffic goes through the tunnel, so tunnel
  bandwidth/latency has zero effect on recording reliability.
- Only live preview playback in the browser goes through the tunnel when
  accessed externally. This should work fine for normal use, but very
  sustained high-bitrate viewing through Cloudflare's free tier is worth
  keeping an eye on if you hit any playback hiccups specifically when
  accessing remotely (vs. fine on LAN) - that'd point to the tunnel path,
  not the app.
- You do not need `TLS_CERT_PATH`/`TLS_KEY_PATH` (the app's optional native
  HTTPS mode) for this setup at all - that's only relevant if you're
  terminating TLS with your own certs instead of a tunnel/reverse proxy.
