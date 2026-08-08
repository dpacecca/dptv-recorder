# DPTV Recorder v1.1 update

This archive contains replacement `public` and `server` folders. Copy those two folders directly over the matching folders in the project root. Do not copy the outer `dptv-recorder-update-v2` folder into the project.

```bash
docker compose down
docker compose build --no-cache
docker compose up -d
```

Then force-refresh the browser with Ctrl+F5. The browser tab title should read **DPTV Recorder v1.1**, and Settings should contain **XC Server | EPG Sources | Recording | Recordings**.

The guide supports the bottom scrollbar, Shift+mouse-wheel, click-and-drag on blank guide space, day buttons and Jump to now. Selecting a current programme starts the muted preview automatically. Selecting a future programme prepares the channel but does not auto-play it.
