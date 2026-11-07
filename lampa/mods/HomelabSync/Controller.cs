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
            version = 1, url = host, uid = InstanceIdentity.Assigned ?? "", token = token ?? ""
        });
        var script = "window.homelabSyncConfig = " + config + ";\n"
            + System.IO.File.ReadAllText(Path.Combine(ModInit.modpath, "plugin.js")) + "\n"
            + System.IO.File.ReadAllText(Path.Combine(ModInit.modpath, "history.js")) + "\n"
            + System.IO.File.ReadAllText(Path.Combine(ModInit.modpath, "online.js")) + "\n"
            + System.IO.File.ReadAllText(Path.Combine(ModInit.modpath, "continue.js"));
        return ContentTo(script, "application/javascript; charset=utf-8");
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
        return ResumeStore.Save(DataArea.Compose(requestInfo.user_uid, Request.Query["profile_id"]), item)
            ? Json(new { success = true }) : BadRequest();
    }
}
