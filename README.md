# YouTube Outlier

Paste a channel link → every upload it has, ranked → pull the transcripts into one PDF.

```bash
npm start        # http://localhost:3100
node test.mjs    # self-check (hits YouTube live, no API key needed)
```

## What it does

**Load Channel** accepts any of: `@handle`, `youtube.com/@handle`, `/channel/UC…`,
`/c/name`, `/user/name`, a raw channel ID, or any video/Shorts URL from the channel.
It pulls the channel's entire uploads playlist with view/like/comment counts —
1,800 videos takes about 20 seconds.

**Sort:** Latest · Popular · Outlier.

**Outlier score** = a video's views ÷ the channel's median views, computed
*within its own format*. Shorts routinely out-view long-form 50:1 on the same
channel, so pooling them would make every Short look like a hit and bury the
real long-form outliers.

**Filters:** format (all/long/Shorts), published window, min views, max views,
min outlier score.

**Get Transcript** transcribes exactly the videos matching your current
filters — not the whole channel — and returns one PDF: a cover with a numbered
contents list, then one page per video (title, views, date, link, then the
transcript). Videos with no captions get a page saying so rather than being
dropped silently. A progress modal tracks it, and a browser notification fires
when the PDF is ready.

## Setup

Copy `.env.example` to `.env` and set `YOUTUBE_API_KEY` — create one at
[console.cloud.google.com](https://console.cloud.google.com/apis/credentials)
with "YouTube Data API v3" enabled for the project. Free tier is 10,000
units/day; loading a 1,800-video channel costs about 75 units.

## How transcripts work

The Data API can't hand out captions for channels you don't own
(`captions.download` is OAuth-gated to the channel owner), so transcripts come
from the same internal player endpoint the YouTube iOS app uses. The `WEB`
client stopped returning caption tracks; `IOS` still does. If YouTube changes
that, `fetchTranscript` in `server.js` is the one function to fix — `node
test.mjs` will tell you the moment it breaks.

Preference order per video: human English captions → auto-generated English →
whatever track exists. PDFs use a full-Unicode system font when one is present,
so non-Latin transcripts render instead of coming out blank.

## Known limits

- Jobs live in memory and expire after an hour; restarting the server drops
  in-flight work. Fine for one local user.
- `MAX_VIDEOS` (default 2000) caps how many uploads are pulled per channel.
- 500 videos max per transcript job.
- Rough timing: about 4 transcripts/second in parallel, so 100 videos ≈ 40s.
