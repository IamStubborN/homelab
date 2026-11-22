# Tracks

Dynamic Lampac module that probes a stream with `ffprobe` and serves the client
script that lists its audio and subtitle tracks. It implements `IModuleLoaded`
only (no `IModuleOnline`). Compose mounts this directory read-only at
`/lampac/mods/Tracks`.

## Behavior on load

- stores its directory in `Tracks.modpath`;
- reads the `Tracks` section of `init.conf` (`ModuleConf`) and reloads it when
  `init.conf` changes;
- inserts its `limit_map` at the start of `CoreInit.conf.WAF.limit_map`;
- creates `database/tracks`, where probe results for torrent streams are cached
  per magnet hash.

## Configuration

`init.conf` section `Tracks`. Defaults: `tsuri = null` (when set, it replaces
the host of TorrServer `/stream/` URLs before probing) and one WAF rule,
`^/ffprobe` limited to 10 requests per second.

## HTTP

| Route | Purpose |
|-------|---------|
| `tracks.js`, `tracks/js/{token}` | Client script, optionally with a route token. |
| `ffprobe?media=…` | Runs `ffprobe` on a TorrServer, DLNA or Lampac proxy stream URL; rate-limited by the WAF rule. |

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | Lampac module manifest: enabled, dynamic, compiled sources. |
| `ModInit.cs` | Load hook, configuration and WAF registration. |
| `ModuleConf.cs` | Configuration model (`tsuri` plus the base WAF settings). |
| `Controller.cs` | `tracks.js` and `ffprobe` routes. |
| `plugin.js` | Client script served by `tracks.js`. |
| `Tracks.csproj` | Project file; references Lampac's `Shared` project. |
