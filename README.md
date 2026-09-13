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

## How the transcript fetcher is scheduled

The Data API can't hand out captions for channels you don't own, and YouTube
bot-blocks datacenter IPs, so on any cloud host every transcript comes through
Apify. That makes scheduling the whole game.

A free Apify account allows **5 concurrent Actor runs** — this isn't in the
limits API, which reports `maxConcurrentActorRuns: null` and a 16GB memory
ceiling that suggests ~64 would fit. Exceed it and runs are refused with
`402 concurrent-runs-limit-exceeded`. With three accounts that's 15 slots.

Each run costs ~20s of startup plus ~3s per video, and every run goes at once,
so a job takes as long as its slowest chunk. Two consequences:

- **Chunk count = available slots**, not a fixed batch size. A fixed size leaves
  later chunks queueing behind earlier ones; sizing to the slots means every
  chunk starts immediately. 118 videos across 15 slots is 8 each in one wave,
  rather than 24 chunks of 5 in two.
- **Chunks are balanced by video length.** A chunk's runtime is driven by the
  videos in it, so splitting the list in order piles the long ones together.
  Dealing longest-first round-robin evens them out: measured on 118 videos,
  133s to 113s. The floor is the single longest video — that channel has a
  10-hour one, and nothing splits it.

Failed chunks are retried once at lower concurrency, because a chunk lost to
throttling would otherwise show up in the PDF as "no captions available",
which is a lie about the video.

Measured end to end: **118 videos, all 118 transcribed, 113s.**

## Known limits

- Jobs live in memory and expire after an hour; restarting the server drops
  in-flight work. Fine for one local user.
- Channel info and video lists persist to Postgres when `DATABASE_URL` is set,
  which is what makes a cold start fast (5.5s to 0.45s on a 330-video channel).
  Transcripts are deliberately not stored. Without the variable everything
  still works, just from memory.
- `MAX_VIDEOS` (default 2000) caps how many uploads are pulled per channel.
- 500 videos max per transcript job.
- Transcript speed is set by the longest video in the batch, not the count.
