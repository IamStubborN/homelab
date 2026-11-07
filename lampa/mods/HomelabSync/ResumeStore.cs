using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace HomelabSync;

public class TrackChoice
{
    public string title { get; set; }
    public string language { get; set; }
    public bool external { get; set; }
    public bool off { get; set; }
}
public class TrackPreferences
{
    public TrackChoice audio { get; set; }
    public TrackChoice subtitles { get; set; }
}
public class OnlineSource
{
    public string provider { get; set; }
    public string voice { get; set; }
    public int season_index { get; set; }
}
public class ResumeItem
{
    public string card { get; set; }
    public string title { get; set; }
    public string poster { get; set; }
    public string backdrop { get; set; }
    public string kind { get; set; } = "torrent";
    public OnlineSource online { get; set; }
    public string original { get; set; }
    public string date { get; set; }
    public string torrent { get; set; }
    public int index { get; set; }
    public string timeline { get; set; }
    public int season { get; set; }
    public int episode { get; set; }
    public double position { get; set; }
    public double duration { get; set; }
    public long observed { get; set; }
    public TrackPreferences tracks { get; set; }
    // A dismissal: hides the card until a newer observation arrives.
    public bool deleted { get; set; }
}

public class SaveResult
{
    public bool ok;
    public bool stale;
    public long observed;
}

public static class ResumeStore
{
    // One Lampac process owns this bind; no new database or identity system.
    static readonly object gate = new();
    // Clocks within this window keep the client stamp; others are clamped.
    const long Skew = 300000;
    // Any client can name a uid/profile; bound how many scope files exist.
    const int MaxScopes = 500;
    static string Folder => Path.Combine("database", "homelab-sync-resume");
    static string FileName(string scope) => Path.Combine(Folder,
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(scope))).ToLowerInvariant() + ".json");
    static string Short(string text, int max) => text == null ? null : text[..Math.Min(text.Length, max)];
    static bool Match(string text, string pattern) => text != null && System.Text.RegularExpressions.Regex.IsMatch(text, pattern);

    static bool Card(string card) => Match(card, @"^(tv|movie)_[1-9][0-9]{0,10}$");
    public static bool Valid(ResumeItem item)
    {
        if (item == null || !Card(item.card)) return false;
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // A skewed device clock is clamped rather than rejected: a rejected
        // write would never be saved and the client would keep retrying it.
        if (item.observed <= 0 || Math.Abs(item.observed - now) > Skew) item.observed = now;
        if (item.deleted)
        {
            var tombstone = new ResumeItem { card = item.card, deleted = true, observed = item.observed, kind = null };
            Copy(tombstone, item);
            return true;
        }
        if (!Match(item.timeline, @"^[a-zA-Z0-9_\-]{1,128}$") || item.season < 0 || item.season > 999 || item.episode < 0 || item.episode > 99999 ||
            !double.IsFinite(item.position) || !double.IsFinite(item.duration) || item.position < 0 || item.duration <= 0 ||
            item.duration > 86400 || item.position > item.duration + 1)
            return false;
        if (item.kind == "torrent")
        {
            if (!Match(item.torrent, @"^[a-f0-9]{40}$") || item.index < 1 || item.index > 999999 || item.online != null) return false;
        }
        else if (item.kind == "online")
        {
            var source = item.online;
            if (item.torrent != null || item.index != 0 || source == null ||
                !Match(source.provider, @"^[a-zA-Z0-9_.\-]{1,80}$") || source.voice == null || source.voice.Length > 200 ||
                source.season_index < 0 || source.season_index > 999) return false;
        }
        else return false;
        item.original = Short(item.original, 200);
        item.date = Match(item.date, @"^[0-9]{4}-[0-9]{2}-[0-9]{2}$") ? item.date : null;
        if (item.card.StartsWith("tv_") && item.episode == 0) return false;
        item.title = Short(item.title, 200);
        item.poster = Match(item.poster, @"^/[a-zA-Z0-9_.\-]{1,150}$") ? item.poster : null;
        item.backdrop = Match(item.backdrop, @"^/[a-zA-Z0-9_.\-]{1,150}$") ? item.backdrop : null;
        foreach (var choice in new[] { item.tracks?.audio, item.tracks?.subtitles })
            if (choice != null) { choice.title = Short(choice.title, 200); choice.language = Short(choice.language, 16); }
        return true;
    }
    static void Copy(ResumeItem from, ResumeItem to)
    {
        foreach (var property in typeof(ResumeItem).GetProperties()) property.SetValue(to, property.GetValue(from));
    }
    public static ResumeItem[] Read(string scope)
    {
        lock (gate) return Load(scope);
    }
    static ResumeItem[] Load(string scope)
    {
        var file = FileName(scope);
        if (!File.Exists(file)) return Array.Empty<ResumeItem>();
        try { return (JsonSerializer.Deserialize<ResumeItem[]>(File.ReadAllText(file)) ?? Array.Empty<ResumeItem>()).Where(i => i != null).ToArray(); }
        catch (JsonException)
        {
            // Keep the unreadable file for inspection and start a clean list,
            // instead of failing every read and write for this scope.
            try { File.Move(file, file + ".corrupt-" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), true); } catch (IOException) { }
            return Array.Empty<ResumeItem>();
        }
    }
    public static SaveResult Save(string scope, ResumeItem item)
    {
        if (!Valid(item)) return null;
        lock (gate)
        {
            var file = FileName(scope);
            if (!File.Exists(file) && Directory.Exists(Folder) && Directory.EnumerateFiles(Folder, "*.json").Count() >= MaxScopes) return null;
            var list = Load(scope).ToList();
            var old = list.FirstOrDefault(i => i.card == item.card);
            // A dismissal always wins over the record it dismisses.
            if (item.deleted && old != null && old.observed >= item.observed) item.observed = old.observed + 1;
            if (old != null && old.observed > item.observed) return new SaveResult { ok = true, stale = true, observed = old.observed };
            list.RemoveAll(i => i.card == item.card);
            list.Add(item);
            Directory.CreateDirectory(Folder);
            var temporary = file + ".tmp";
            try
            {
                using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
                { JsonSerializer.Serialize(stream, list.OrderByDescending(i => i.observed).Take(50).ToArray()); stream.Flush(true); }
                File.Move(temporary, file, true);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
            return new SaveResult { ok = true, observed = item.observed };
        }
    }
}
