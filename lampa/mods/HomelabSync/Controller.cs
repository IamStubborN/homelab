using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using System;
using Shared;
using Shared.Services;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;

namespace HomelabSync;

public class HomelabSyncController : BaseController
{
    [HttpGet, AllowAnonymous]
    [Route("homelab-sync.js")]
    [Route("homelab-sync/js/{token}")]
    public ActionResult Plugin(string token)
    {
        Response.Headers["Cache-Control"] = "no-store";
        var config = JsonSerializer.Serialize(new {
            version = 1, url = host, uid = InstanceIdentity.Assigned ?? "", token = token ?? "",
            assets = new { sources = AssetVersion("common-sources.js"), thumbnails = AssetVersion("playlist-thumbnails.js") }
        });
        var script = "window.homelabSyncConfig = " + config + ";\n"
            + System.IO.File.ReadAllText(Path.Combine(ModInit.modpath, "plugin.js")) + "\n"
            + System.IO.File.ReadAllText(Path.Combine(ModInit.modpath, "history.js")) + "\n"
            + System.IO.File.ReadAllText(Path.Combine(ModInit.modpath, "online.js")) + "\n"
            + System.IO.File.ReadAllText(Path.Combine(ModInit.modpath, "quality.js")) + "\n"
            + System.IO.File.ReadAllText(Path.Combine(ModInit.modpath, "continue.js"));
        return ContentTo(script, "application/javascript; charset=utf-8");
    }

    // The picker plugins are plain static files the WebView may cache; their modification time
    // becomes the cache-busting version, so a deploy reaches every device on its next start.
    static string AssetVersion(string name)
    {
        try
        {
            var file = Path.Combine(Directory.GetCurrentDirectory(), "wwwroot", "plugins", "homelab", name);
            return System.IO.File.Exists(file) ? System.IO.File.GetLastWriteTimeUtc(file).Ticks.ToString("x") : "";
        }
        catch { return ""; }
    }

        [HttpGet, Route("homelab-sync/resume")]
    public ActionResult Resume()
    {
        Response.Headers["Cache-Control"] = "no-store";
        if (requestInfo.user_uid == null) return Unauthorized();
        return Json(new { version = 1, items = ResumeStore.Read(DataArea.Compose(requestInfo.user_uid, Request.Query["profile_id"])) });
    }

    [HttpPost, Route("homelab-sync/resume")]
    public async Task<ActionResult> SaveResume()
    {
        Response.Headers["Cache-Control"] = "no-store";
        if (requestInfo.user_uid == null) return Unauthorized();
        if (Request.ContentLength > 16384) return StatusCode(413);
        var buffer = new byte[16385];
        int count = 0;
        while (count < buffer.Length)
        {
            int read = await Request.Body.ReadAsync(buffer.AsMemory(count), HttpContext.RequestAborted);
            if (read == 0) break;
            count += read;
        }
        if (count > 16384) return StatusCode(413);
        ResumeItem item;
        try { item = JsonSerializer.Deserialize<ResumeItem>(buffer.AsSpan(0, count)); }
        catch (JsonException) { return BadRequest(); }
        var result = ResumeStore.Save(DataArea.Compose(requestInfo.user_uid, Request.Query["profile_id"]), item);
        if (result == null) return BadRequest();
        if (result.full) return StatusCode(507);
        return Json(new { success = true, stale = result.stale, result.observed });
    }

    [HttpGet, Route("homelab-sync/quality")]
    public ActionResult Quality(string card)
    {
        Response.Headers["Cache-Control"] = "no-store";
        if (requestInfo.user_uid == null) return Unauthorized();
        return Json(QualityStore.Read(card));
    }

    [HttpPost, Route("homelab-sync/quality")]
    public async Task<ActionResult> SaveQuality()
    {
        Response.Headers["Cache-Control"] = "no-store";
        if (requestInfo.user_uid == null) return Unauthorized();
        if (Request.ContentLength > 2048) return StatusCode(413);
        var buffer = new byte[2049];
        int count = 0;
        while (count < buffer.Length)
        {
            int read = await Request.Body.ReadAsync(buffer.AsMemory(count), HttpContext.RequestAborted);
            if (read == 0) break;
            count += read;
        }
        if (count > 2048) return StatusCode(413);
        QualityReport report;
        try { report = JsonSerializer.Deserialize<QualityReport>(buffer.AsSpan(0, count)); }
        catch (JsonException) { return BadRequest(); }
        return QualityStore.Save(report) ? Json(new { success = true }) : BadRequest();
    }
}
