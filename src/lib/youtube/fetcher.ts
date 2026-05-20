/**
 * YouTube channel-feed fetcher (no API key required).
 *
 * Uses YouTube's public RSS feed endpoint, which returns the channel's
 * 15 most-recent videos with id + title + publication time. Free, no auth,
 * no rate limit issues.
 */
export interface YouTubeVideo {
  videoId: string;
  channelId: string;
  channelName: string;
  title: string;
  publishedAt: string;          // ISO 8601
  url: string;
}

/**
 * Fetch the latest videos for a channel via its public Atom feed.
 * Filters to videos published within `maxAgeDays`.
 */
export async function fetchChannelVideos(
  channelId: string,
  channelName: string,
  maxAgeDays = 7
): Promise<YouTubeVideo[]> {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  const res = await fetch(url, {
    headers: { 'user-agent': 'fpl-trading-desk/0.1' },
    cache: 'no-store'
  });
  if (!res.ok) {
    throw new Error(`YouTube RSS ${res.status} for ${channelId}`);
  }
  const xml = await res.text();
  return parseAtomFeed(xml, channelId, channelName, maxAgeDays);
}

/**
 * Tiny purpose-built Atom parser. Avoids pulling in a 200KB XML lib for
 * something this regular. Tags we care about:
 *   <entry>
 *     <yt:videoId>...</yt:videoId>
 *     <title>...</title>
 *     <published>...</published>
 *   </entry>
 */
function parseAtomFeed(
  xml: string,
  channelId: string,
  channelName: string,
  maxAgeDays: number
): YouTubeVideo[] {
  const out: YouTubeVideo[] = [];
  const minPublishedAt = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const entries = xml.split(/<entry>/g).slice(1);
  for (const entry of entries) {
    const videoId  = matchTag(entry, 'yt:videoId') ?? matchTag(entry, 'videoId');
    const title    = matchTag(entry, 'title');
    const publishedAt = matchTag(entry, 'published');
    if (!videoId || !title || !publishedAt) continue;
    if (new Date(publishedAt).getTime() < minPublishedAt) continue;
    out.push({
      videoId,
      channelId,
      channelName,
      title: decodeXml(title),
      publishedAt,
      url: `https://www.youtube.com/watch?v=${videoId}`
    });
  }
  return out;
}

function matchTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const m = xml.match(re);
  return m?.[1]?.trim() ?? null;
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
