# DPTV Recorder update

Back up the existing project and `data/guide.db`, then copy the `public` and `server` folders over the matching folders in the repository.

Rebuild and restart Docker:

```bash
docker compose down
docker compose up -d --build
```

Open Settings > EPG Sources to add an XMLTV URL. The application tests the source before saving it. Select **Use** beside the desired source, then select **Sync now**.

## Included changes

- Multiple saved XMLTV EPG sources.
- Built-in Xtream Codes EPG preserved as the default source.
- Selection of the active EPG source used for the XC playlist.
- Optional HTTP Basic authentication for custom XMLTV URLs.
- Configurable fallback timezone for XMLTV timestamps that omit an offset.
- Perth is the default fallback timezone.
- Australian local time formatting in the browser.
- The guide automatically scrolls to the current time after loading or syncing.
- Date chips visibly select and smoothly scroll to the selected day.

## Notes

- Custom EPG channel IDs must match each channel's `epg_channel_id` supplied by the XC playlist.
- Existing databases are upgraded automatically by `server/db.js`.
- The custom EPG password is stored in the same local SQLite database as the existing XC credentials.
