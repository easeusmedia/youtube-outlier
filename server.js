import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import { pathToFileURL } from 'url';
import PDFDocument from 'pdfkit';

const API_KEY = process.env.YOUTUBE_API_KEY || process.env.API_KEY;
const PORT = process.env.PORT || 3100;
const MAX_VIDEOS = Number(process.env.MAX_VIDEOS || 2000);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

/* ------------------------------------------------------------------ *
 * YouTube Data API v3
 * ------------------------------------------------------------------ */

async function yt(path, params) {
  if (!API_KEY) throw new Error('YOUTUBE_API_KEY is not set. Add it to .env and restart.');
  const url = new URL('https://www.googleapis.com/youtube/v3/' + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', API_KEY);
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = json?.error?.errors?.[0]?.reason;
    if (reason === 'quotaExceeded') throw new Error('YouTube API daily quota exceeded. Try again after midnight PT.');
    throw new Error(json?.error?.message || `YouTube API error ${res.status}`);
  }
  return json;
}

// Accepts anything a user might paste: channel URL in any of its five shapes,
// a bare @handle, a video/Shorts URL, or a raw channel ID.
async function resolveChannel(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Paste a YouTube channel link.');

  const videoId =
    raw.match(/(?:v=|\/shorts\/|\/live\/|youtu\.be\/)([\w-]{11})/)?.[1] ||
    (/^[\w-]{11}$/.test(raw) && !raw.startsWith('UC') ? raw : null);
  if (videoId) {
    const v = await yt('videos', { part: 'snippet', id: videoId });
    const id = v.items?.[0]?.snippet?.channelId;
    if (!id) throw new Error('That video link did not resolve to a channel.');
    return channelById({ id });
  }

  const byId = raw.match(/channel\/(UC[\w-]{20,})/)?.[1] || (/^UC[\w-]{20,}$/.test(raw) ? raw : null);
  if (byId) return channelById({ id: byId });

  const handle = raw.match(/youtube\.com\/@([\w.\-]+)/)?.[1] || raw.match(/^@([\w.\-]+)$/)?.[1];
  if (handle) return channelById({ forHandle: '@' + handle });

  const legacy = raw.match(/youtube\.com\/(?:c|user)\/([\w.\-]+)/)?.[1];
  if (legacy) {
    const byUser = await yt('channels', { part: 'snippet,contentDetails,statistics', forUsername: legacy });
    if (byUser.items?.length) return shapeChannel(byUser.items[0]);
    // /c/ vanity names have no direct lookup — search is the only way in.
    const hit = await yt('search', { part: 'snippet', type: 'channel', q: legacy, maxResults: 1 });
    const id = hit.items?.[0]?.snippet?.channelId || hit.items?.[0]?.id?.channelId;
    if (id) return channelById({ id });
  }

  if (!raw.includes('/') && !raw.includes('.')) return channelById({ forHandle: '@' + raw.replace(/^@/, '') });
  throw new Error('Could not read a channel out of that link.');
}

async function channelById(query) {
  const res = await yt('channels', { part: 'snippet,contentDetails,statistics', ...query });
  if (!res.items?.length) throw new Error('No channel found for that link.');
  return shapeChannel(res.items[0]);
}

function shapeChannel(c) {
  return {
    id: c.id,
    title: c.snippet.title,
    handle: c.snippet.customUrl || '',
    avatar: c.snippet.thumbnails?.medium?.url || c.snippet.thumbnails?.default?.url || '',
    subs: Number(c.statistics.subscriberCount || 0),
    hiddenSubs: !!c.statistics.hiddenSubscriberCount,
    videoCount: Number(c.statistics.videoCount || 0),
    uploads: c.contentDetails.relatedPlaylists.uploads,
  };
}

// ISO-8601 duration -> seconds. PT1H2M3S, PT45S, P1DT2H all show up in the wild.
function parseDuration(iso) {
  const m = String(iso || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function fetchAllVideos(uploadsId) {
  const ids = [];
  let pageToken = '';
  do {
    const page = await yt('playlistItems', {
      part: 'contentDetails',
      playlistId: uploadsId,
      maxResults: 50,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const it of page.items || []) ids.push(it.contentDetails.videoId);
    pageToken = page.nextPageToken || '';
  } while (pageToken && ids.length < MAX_VIDEOS);

  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = await yt('videos', {
      part: 'snippet,statistics,contentDetails',
      id: ids.slice(i, i + 50).join(','),
    });
    for (const v of batch.items || []) {
      const seconds = parseDuration(v.contentDetails.duration);
      videos.push({
        id: v.id,
        title: v.snippet.title,
        thumb: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || '',
        publishedAt: v.snippet.publishedAt,
        views: Number(v.statistics.viewCount || 0),
        likes: Number(v.statistics.likeCount || 0),
        comments: Number(v.statistics.commentCount || 0),
        seconds,
        isShort: seconds > 0 && seconds <= 60,
      });
    }
  }

  // Outlier score = views / median views, measured within the video's own
  // format. Shorts routinely out-view long-form 50:1 on the same channel, so
  // pooling them makes every Short an "outlier" and hides the real ones.
  for (const kind of [true, false]) {
    const group = videos.filter((v) => v.isShort === kind);
    const base = median(group.map((v) => v.views)) || 1;
    for (const v of group) v.outlier = Math.round((v.views / base) * 100) / 100;
  }
  return videos;
}

const channelCache = new Map(); // key -> { at, payload }
const CACHE_MS = 15 * 60 * 1000;

app.post('/api/channel', async (req, res) => {
  try {
    const key = String(req.body?.url || '').trim().toLowerCase();
    const hit = channelCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.payload);

    const channel = await resolveChannel(req.body?.url);
    const videos = await fetchAllVideos(channel.uploads);
    const payload = { channel, videos, truncated: videos.length >= MAX_VIDEOS };
    channelCache.set(key, { at: Date.now(), payload });
    res.json(payload);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ *
 * Transcripts
 *
 * The Data API cannot hand out captions for channels you don't own
 * (captions.download is OAuth-gated), so this goes through the same
 * innertube player endpoint the YouTube app uses. The WEB client stopped
 * returning caption tracks; IOS still does.
 * ------------------------------------------------------------------ */

async function fetchTranscript(videoId) {
  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'com.google.ios.youtube/20.10.4 (iPhone; U; CPU iOS 18_0 like Mac OS X)' },
    body: JSON.stringify({
      videoId,
      context: { client: { clientName: 'IOS', clientVersion: '20.10.4', hl: 'en', gl: 'US' } },
    }),
  });
  if (!res.ok) throw new Error(`player ${res.status}`);
  const data = await res.json();

  const status = data?.playabilityStatus?.status;
  if (status && status !== 'OK') throw new Error(status === 'LOGIN_REQUIRED' ? 'private or age-restricted' : String(status).toLowerCase());

  const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) throw new Error('no captions available');

  // Prefer a human English track, then auto-English, then whatever exists.
  const pick =
    tracks.find((t) => t.languageCode?.startsWith('en') && t.kind !== 'asr') ||
    tracks.find((t) => t.languageCode?.startsWith('en')) ||
    tracks[0];

  // YouTube rate-limits this endpoint hard once you burst it — a few dozen
  // rapid fetches is enough to earn a 429 that outlasts a minute. Back off
  // instead of writing "no captions" into the PDF for a video that has them.
  let cap;
  for (const wait of [0, 3000, 9000, 20000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    cap = await fetch(pick.baseUrl + '&fmt=json3');
    if (cap.status !== 429) break;
  }
  if (!cap.ok) throw new Error(cap.status === 429 ? 'rate-limited by YouTube' : `captions ${cap.status}`);
  const json = await cap.json().catch(() => null);
  const events = json?.events;
  if (!events) throw new Error('caption track was empty');

  // Segments inside one cue are word fragments (join tight); separate cues are
  // separate phrases (join with a space, or "…DrawHi everyone" happens).
  const text = events
    .map((e) => (e.segs || []).map((s) => s.utf8 || '').join(''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) throw new Error('caption track was empty');
  return { text, lang: pick.languageCode, auto: pick.kind === 'asr' };
}

/* ------------------------------------------------------------------ *
 * PDF
 * ------------------------------------------------------------------ */

// Helvetica is Latin-1 only, so anything outside it comes out blank. Look for a
// wider font: macOS ships Arial Unicode, Render's Debian image ships DejaVu.
// ponytail: DejaVu still has no Devanagari/CJK — bundle a Noto font if a
// channel's captions actually come back in one of those scripts.
const UNICODE_FONT = [
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
].find((p) => fs.existsSync(p));
const hasUnicodeFont = !!UNICODE_FONT;

function buildPdf({ channel, items }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 54, bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    if (hasUnicodeFont) doc.registerFont('body', UNICODE_FONT);
    const REG = hasUnicodeFont ? 'body' : 'Helvetica';
    const BOLD = hasUnicodeFont ? 'body' : 'Helvetica-Bold';

    // Cover
    doc.font(BOLD).fontSize(26).fillColor('#111').text(channel.title, { width: 460 });
    doc.moveDown(0.3);
    doc.font(REG).fontSize(11).fillColor('#666')
      .text(`${items.length} transcript${items.length === 1 ? '' : 's'}  ·  generated ${new Date().toLocaleString()}`);
    doc.moveDown(1.2);
    doc.font(BOLD).fontSize(11).fillColor('#111').text('Contents');
    doc.moveDown(0.4);
    doc.font(REG).fontSize(10).fillColor('#333');
    items.forEach((it, i) => doc.text(`${i + 1}.  ${it.title}`, { width: 470 }));

    for (const it of items) {
      doc.addPage();
      doc.font(BOLD).fontSize(15).fillColor('#111').text(it.title, { width: 470 });
      doc.moveDown(0.35);
      const meta = [
        it.views.toLocaleString() + ' views',
        new Date(it.publishedAt).toLocaleDateString(),
        it.error ? null : it.auto ? 'auto-captions' : 'captions',
      ].filter(Boolean).join('  ·  ');
      doc.font(REG).fontSize(9).fillColor('#888').text(meta);
      doc.fontSize(9).fillColor('#0073E6').text(`https://www.youtube.com/watch?v=${it.id}`);
      doc.moveDown(0.9);
      if (it.error) {
        doc.font(REG).fontSize(10.5).fillColor('#b00').text(`No transcript: ${it.error}`);
      } else {
        doc.font(REG).fontSize(10.5).fillColor('#1a1a1a')
          .text(it.text, { align: 'left', lineGap: 2.5 });
      }
    }

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.font(REG).fontSize(8).fillColor('#aaa')
        .text(`${i + 1} / ${range.count}`, 54, doc.page.height - 38, { width: doc.page.width - 108, align: 'center' });
    }
    doc.end();
  });
}

/* ------------------------------------------------------------------ *
 * Transcript jobs
 * ------------------------------------------------------------------ */

const jobs = new Map();
const CONCURRENCY = 2; // 4 gets you 429'd by YouTube on real-size jobs

async function runJob(job, videos) {
  const results = new Array(videos.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, videos.length) }, async () => {
      while (next < videos.length) {
        const i = next++;
        const v = videos[i];
        try {
          const t = await fetchTranscript(v.id);
          results[i] = { ...v, ...t };
          job.ok++;
        } catch (err) {
          results[i] = { ...v, error: err.message };
          job.failed++;
          job.reasons[err.message] = (job.reasons[err.message] || 0) + 1;
        }
        job.done++;
        job.current = v.title;
      }
    })
  );

  job.status = 'building';
  job.pdf = await buildPdf({ channel: job.channel, items: results });
  job.status = 'done';
  job.finishedAt = Date.now();
}

app.post('/api/transcripts', async (req, res) => {
  const videos = Array.isArray(req.body?.videos) ? req.body.videos.slice(0, 500) : [];
  const channel = req.body?.channel;
  if (!videos.length || !channel?.title) return res.status(400).json({ error: 'Nothing to transcribe.' });

  const id = Math.random().toString(36).slice(2, 10);
  const job = { id, channel, total: videos.length, done: 0, ok: 0, failed: 0, status: 'running', current: '', reasons: {} };
  jobs.set(id, job);

  runJob(job, videos).catch((err) => {
    job.status = 'error';
    job.error = err.message;
  });

  // ponytail: jobs live in memory and are dropped after an hour. Restarting the
  // server loses in-flight work — fine for one local user; move to disk if this
  // ever gets deployed for more.
  setTimeout(() => jobs.delete(id), 60 * 60 * 1000).unref?.();
  res.json({ id, total: videos.length });
});

app.get('/api/transcripts/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job expired or not found.' });
  const { id, total, done, ok, failed, status, current, error, reasons } = job;
  res.json({ id, total, done, ok, failed, status, current, error, reasons, ready: status === 'done' });
});

app.get('/api/transcripts/:id/pdf', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.pdf) return res.status(404).send('Not ready.');
  const name = job.channel.title.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-') || 'transcripts';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-transcripts.pdf"`);
  res.send(job.pdf);
});

app.get('/api/config', (_req, res) => res.json({ hasKey: !!API_KEY }));

// Only listen when run as the entrypoint, so test.mjs can import the helpers.
// argv[1] is undefined under `node -e`, and pathToFileURL throws on undefined.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(PORT, () => {
    console.log(`YouTube Outlier  →  http://localhost:${PORT}`);
    if (!API_KEY) console.log('⚠  YOUTUBE_API_KEY missing — add it to .env, then restart.');
  });
}

export { parseDuration, median, fetchTranscript, buildPdf, app };
