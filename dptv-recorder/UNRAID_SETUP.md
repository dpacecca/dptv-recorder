# Installing on Unraid

## Recommended: use the included template

The repo includes `unraid-template.xml`, which correctly declares `/data`
and `/recordings` as **Path** mappings only. This matters because it avoids
a real gotcha (see below): if Unraid's Community Applications auto-converts
a `docker-compose.yml`/image into a template on the fly, it can mistake
`DB_PATH`/`RECORDINGS_PATH` for host-path variables and pre-fill them with
the wrong (host-side) paths, which crashes the app on boot with `EACCES`.
The included template sidesteps that entirely by never exposing those two
as editable variables in the first place - only the actual volume mappings
are user-configurable, which is the only place those paths should come from.

### Install it

1. In the Unraid terminal (or via SSH):
   ```bash
   cp unraid-template.xml /boot/config/plugins/dockerMan/templates-user/dptv-recorder.xml
   ```
   (adjust the source path to wherever you have the repo checked out)

2. **Docker** tab → **Add Container** → in the **Template** dropdown, select
   **dptv-recorder**. All fields will be pre-filled correctly:
   - `/data` → `/mnt/user/appdata/dptv-recorder/data`
   - `/recordings` → `/mnt/user/data/media/recordings`
   - `PUID=99`, `PGID=100`, `TZ=UTC` (change `TZ` to your own, e.g.
     `Australia/Perth`)

3. Adjust the host paths/port if you want something different, then **Apply**.

## If you already installed it via CA's auto-conversion and it's crashing

You'll see something like:
```
Error: EACCES: permission denied, mkdir '/mnt/user/appdata/dptv-recorder'
```
This means `DB_PATH` and/or `RECORDINGS_PATH` got set to a **host** path
(e.g. `/mnt/user/appdata/dptv-recorder/data/`) instead of the correct
**container-internal** path. Fix it directly:

1. **Docker** tab → click the container's icon → **Edit**
2. Find the `DB_PATH` variable: delete it, or set it to exactly `/data/guide.db`
3. Find the `RECORDINGS_PATH` variable: delete it, or set it to exactly `/recordings`
4. Leave the actual **Path** mappings (the `/data` and `/recordings` volume
   entries) as they are - those are what should control the host-side
   locations, not the env vars.
5. **Apply**

If the SQLite database was already created while the container was running
as root (before you had `PUID`/`PGID` set correctly), you may also see a
`SQLITE_READONLY` error. Fix ownership once with:
```bash
chown -R 99:100 /mnt/user/appdata/dptv-recorder/data
```
(swap `99:100` for your actual `PUID:PGID` if you changed them from the default)

## Why this happened

`DB_PATH` and `RECORDINGS_PATH` are internal, fixed, container-side paths
(`/data/guide.db` and `/recordings`) baked into the image as defaults -
they're not meant to be edited at all. The *host* side of where things land
is controlled entirely through the volume mappings (`-v host:/data`,
`-v host:/recordings`). Any tool that auto-generates a template from the
image/compose file and doesn't know that distinction can end up conflating
the two. Using `unraid-template.xml` avoids the ambiguity by simply never
listing `DB_PATH`/`RECORDINGS_PATH` as configurable fields.
