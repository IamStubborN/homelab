using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;

namespace HomelabSync;

// One observation: the height a source claimed for a row and the height found by a manifest
// probe or seen while playing it.
public class QualityReport
{
    public string card { get; set; }
    public string provider { get; set; }
    public int season { get; set; }
    public string voice { get; set; }
    public int claimed { get; set; }
    public int measured { get; set; }
    public string source { get; set; }
}
public class QualityFact
{
    public int claimed { get; set; }
    public int probe { get; set; }
    public int play { get; set; }
    public long at { get; set; }
}
public class QualityTitle
{
    public long at { get; set; }
    public Dictionary<string, QualityFact> rows { get; set; } = new();
}
public class ProviderHonesty
{
    public int total { get; set; }
    public int inflated { get; set; }
}
public class QualityData
{
    public int version { get; set; } = 1;
    public Dictionary<string, QualityTitle> titles { get; set; } = new();
}

// Facts about sources, not about people: shared by every profile of this Lampac.
public static class QualityStore
{
    static readonly object gate = new();
    static readonly int[] Heights = { 0, 360, 480, 576, 720, 1080, 1440, 2160 };
    const int MaxTitles = 2000, MaxRows = 60;
    const long Ttl = 60L * 24 * 3600 * 1000, ProbeTtl = 7L * 24 * 3600 * 1000;
    static string FileName => Path.Combine("database", "homelab-sync-quality.json");
    static QualityData cache;

    static bool Match(string text, string pattern) => text != null && System.Text.RegularExpressions.Regex.IsMatch(text, pattern);
    public static bool Valid(QualityReport report) =>
        report != null && Match(report.card, @"^(tv|movie)_[1-9][0-9]{0,10}$") && Match(report.provider, @"^[a-zA-Z0-9_.\-]{1,80}$") &&
        report.season >= 0 && report.season <= 999 && report.voice != null && report.voice.Length <= 200 &&
        Heights.Contains(report.claimed) && Heights.Contains(report.measured) && report.measured > 0 &&
        (report.source == "probe" || report.source == "play");
    static string Key(QualityReport report) => report.provider.ToLowerInvariant() + "|" + report.season + "|" + report.voice.Trim().ToLowerInvariant();
    // The lower measurement wins: a manifest can name a height its picture does not have.
    public static int Effective(QualityFact fact) => fact.play > 0 && (fact.probe == 0 || fact.play < fact.probe) ? fact.play : fact.probe;

    static QualityData Load()
    {
        if (cache != null) return cache;
        try { cache = File.Exists(FileName) ? JsonSerializer.Deserialize<QualityData>(File.ReadAllText(FileName)) : null; }
        catch (Exception error) when (error is JsonException || error is IOException || error is UnauthorizedAccessException)
        {
            try { File.Move(FileName, FileName + ".corrupt-" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), true); } catch (IOException) { }
        }
        cache ??= new QualityData();
        cache.titles ??= new();
        return cache;
    }

    // Facts still trusted: a probe is redone after a week (sources add better copies), a playback stays longer.
    static bool Live(QualityFact fact, long now) => now - fact.at < (fact.play > 0 ? Ttl : ProbeTtl);

    public static object Read(string card)
    {
        lock (gate)
        {
            var data = Load();
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var rows = new Dictionary<string, object>();
            if (card != null && data.titles.TryGetValue(card, out var title))
                foreach (var entry in title.rows.Where(r => Live(r.Value, now)))
                    rows[entry.Key] = new { height = Effective(entry.Value), entry.Value.claimed, source = entry.Value.play > 0 ? "play" : "probe" };
            // Honesty counts only live facts, so evicted or expired rows never leave stale votes.
            var providers = new Dictionary<string, ProviderHonesty>();
            foreach (var pair in data.titles.Values.SelectMany(t => t.rows))
            {
                var fact = pair.Value;
                if (fact.claimed <= 0 || !Live(fact, now)) continue;
                var provider = pair.Key[..pair.Key.IndexOf('|')];
                if (!providers.TryGetValue(provider, out var honesty)) providers[provider] = honesty = new ProviderHonesty();
                honesty.total++; if (Effective(fact) < fact.claimed) honesty.inflated++;
            }
            return new { version = 1, rows, providers = providers.ToDictionary(p => p.Key, p => new { p.Value.total, p.Value.inflated }) };
        }
    }

    public static bool Save(QualityReport report)
    {
        if (!Valid(report)) return false;
        lock (gate)
        {
            var data = Load();
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (!data.titles.TryGetValue(report.card, out var title)) data.titles[report.card] = title = new QualityTitle();
            var key = Key(report);
            if (!title.rows.TryGetValue(key, out var fact))
            {
                if (title.rows.Count >= MaxRows) title.rows.Remove(title.rows.OrderBy(r => r.Value.at).First().Key);
                title.rows[key] = fact = new QualityFact();
            }
            if (report.claimed > 0) fact.claimed = report.claimed;
            if (report.source == "play") fact.play = report.measured; else fact.probe = report.measured;
            fact.at = title.at = now;
            if (data.titles.Count > MaxTitles)
                foreach (var old in data.titles.OrderBy(t => t.Value.at).Take(data.titles.Count - MaxTitles).Select(t => t.Key).ToList()) data.titles.Remove(old);
            // Several reports arrive together (one per probed row): write once they settle.
            if (!flushing) { flushing = true; System.Threading.Tasks.Task.Delay(3000).ContinueWith(_ => Flush()); }
            return true;
        }
    }

    static bool flushing;
    static void Flush()
    {
        lock (gate)
        {
            flushing = false;
            try
            {
                Directory.CreateDirectory("database");
                var temporary = FileName + ".tmp";
                try
                {
                    using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
                    { JsonSerializer.Serialize(stream, cache); stream.Flush(true); }
                    File.Move(temporary, FileName, true);
                }
                finally { if (File.Exists(temporary)) File.Delete(temporary); }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }
}
