import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import { pathToFileURL } from 'url';
import PDFDocument from 'pdfkit';
import pg from 'pg';

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
        // The Data API exposes no "is a Short" flag, so duration is the only
        // signal. YouTube raised the Shorts ceiling to 3 minutes, and spot
        // checks against /shorts/<id> confirm 61-180s uploads really are
        // Shorts — a 60s cutoff leaked them into the long-form filter.
        isShort: seconds > 0 && seconds <= 180,
      });
    }
  }

  scoreOutliers(videos);
  return videos;
}

// Outlier score = views / median views, measured within the video's own
// format. Shorts routinely out-view long-form 50:1 on the same channel, so
// pooling them makes every Short an "outlier" and hides the real ones. Applied
// on the way out of the database too, so a cached channel scores identically.
function scoreOutliers(videos) {
  for (const kind of [true, false]) {
    const group = videos.filter((v) => v.isShort === kind);
    const base = median(group.map((v) => v.views)) || 1;
    for (const v of group) v.outlier = Math.round((v.views / base) * 100) / 100;
  }
  return videos;
}

/* ------------------------------------------------------------------ *
 * Persistence
 *
 * Optional: without DATABASE_URL everything still works, just from memory.
 * It matters on Render's free tier, where the instance sleeps after 15
 * minutes and every cold start otherwise re-fetched the whole channel.
 * Tables are yt_-prefixed so this can share a database with another app.
 * Transcripts are deliberately not stored — only what makes a channel load
 * fast.
 * ------------------------------------------------------------------ */

const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 4,
    })
  : null;

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS yt_channels (
      id           TEXT PRIMARY KEY,
      title        TEXT NOT NULL,
      handle       TEXT,
      avatar       TEXT,
      subs         BIGINT,
      hidden_subs  BOOLEAN,
      video_count  INTEGER,
      uploads      TEXT,
      fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS yt_videos (
      id           TEXT PRIMARY KEY,
      channel_id   TEXT NOT NULL,
      title        TEXT,
      thumb        TEXT,
      published_at TIMESTAMPTZ,
      views        BIGINT,
      likes        BIGINT,
      comments     BIGINT,
      seconds      INTEGER,
      is_short     BOOLEAN
    );
    CREATE INDEX IF NOT EXISTS yt_videos_channel ON yt_videos (channel_id);
    -- Every spelling of a link that resolved to a channel. Worth persisting on
    -- its own: a legacy /c/ link costs a 100-unit search to resolve, against 1
    -- unit for everything else here.
    CREATE TABLE IF NOT EXISTS yt_aliases (
      alias      TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL
    );
  `);
  console.log('database ready');
}

async function dbGetAlias(alias) {
  if (!pool) return null;
  const { rows } = await pool.query('SELECT channel_id FROM yt_aliases WHERE alias = $1', [alias]);
  return rows[0]?.channel_id || null;
}

async function dbSaveAlias(alias, channelId) {
  if (!pool) return;
  await pool.query(
    'INSERT INTO yt_aliases (alias, channel_id) VALUES ($1, $2) ON CONFLICT (alias) DO UPDATE SET channel_id = EXCLUDED.channel_id',
    [alias, channelId]
  );
}

async function dbLoadChannel(channelId) {
  if (!pool) return null;
  const { rows } = await pool.query('SELECT * FROM yt_channels WHERE id = $1', [channelId]);
  const c = rows[0];
  if (!c) return null;
  const { rows: vids } = await pool.query(
    'SELECT * FROM yt_videos WHERE channel_id = $1 ORDER BY published_at DESC',
    [channelId]
  );
  return {
    channel: {
      id: c.id,
      title: c.title,
      handle: c.handle || '',
      avatar: c.avatar || '',
      subs: Number(c.subs || 0),
      hiddenSubs: !!c.hidden_subs,
      videoCount: Number(c.video_count || 0),
      uploads: c.uploads,
    },
    videos: scoreOutliers(
      vids.map((v) => ({
        id: v.id,
        title: v.title,
        thumb: v.thumb || '',
        publishedAt: new Date(v.published_at).toISOString(),
        views: Number(v.views || 0),
        likes: Number(v.likes || 0),
        comments: Number(v.comments || 0),
        seconds: v.seconds || 0,
        isShort: !!v.is_short,
      }))
    ),
    fetchedAt: new Date(c.fetched_at).getTime(),
  };
}

async function dbSaveChannel(channel, videos) {
  if (!pool) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO yt_channels (id, title, handle, avatar, subs, hidden_subs, video_count, uploads, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title, handle = EXCLUDED.handle, avatar = EXCLUDED.avatar,
         subs = EXCLUDED.subs, hidden_subs = EXCLUDED.hidden_subs,
         video_count = EXCLUDED.video_count, uploads = EXCLUDED.uploads, fetched_at = now()`,
      [channel.id, channel.title, channel.handle, channel.avatar, channel.subs,
       channel.hiddenSubs, channel.videoCount, channel.uploads]
    );

    // Chunked so the statement stays well inside Postgres' parameter ceiling.
    const COLS = 10;
    for (let i = 0; i < videos.length; i += 400) {
      const batch = videos.slice(i, i + 400);
      const params = [];
      const tuples = batch.map((v, n) => {
        params.push(v.id, channel.id, v.title, v.thumb, v.publishedAt,
                    v.views, v.likes, v.comments, v.seconds, v.isShort);
        const b = n * COLS;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`;
      });
      await client.query(
        `INSERT INTO yt_videos (id, channel_id, title, thumb, published_at, views, likes, comments, seconds, is_short)
         VALUES ${tuples.join(',')}
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title, thumb = EXCLUDED.thumb, published_at = EXCLUDED.published_at,
           views = EXCLUDED.views, likes = EXCLUDED.likes, comments = EXCLUDED.comments,
           seconds = EXCLUDED.seconds, is_short = EXCLUDED.is_short`,
        params
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // A cache that can't write is not a reason to fail the request.
    console.error('db save failed:', err.message);
  } finally {
    client.release();
  }
}

// Two caches, because they expire on completely different clocks. Which
// channel a link points at never changes, so that mapping is kept forever —
// worth it because resolving a legacy /c/ link costs a 100-unit search, a
// hundred times more than every other call in this file. The video list does
// change, so it expires, but keying it by channel id means the five ways of
// writing the same channel share one entry instead of refetching per spelling.
const resolveCache = new Map(); // input string -> channel
const channelCache = new Map(); // channel id -> { at, payload }
const CACHE_MS = 60 * 60 * 1000;

app.post('/api/channel', async (req, res) => {
  try {
    const key = String(req.body?.url || '').trim().toLowerCase();

    // Memory first, then the database, then YouTube — cheapest to dearest.
    let channel = resolveCache.get(key);
    if (!channel) {
      const knownId = await dbGetAlias(key).catch(() => null);
      const stored = knownId ? await dbLoadChannel(knownId).catch(() => null) : null;
      if (stored) {
        channel = stored.channel;
        resolveCache.set(key, channel);
        if (stored.videos.length && Date.now() - stored.fetchedAt < CACHE_MS) {
          const payload = { channel, videos: stored.videos, truncated: false, cached: true };
          channelCache.set(channel.id, { at: stored.fetchedAt, payload });
          return res.json(payload);
        }
      }
    }
    if (!channel) {
      channel = await resolveChannel(req.body?.url);
      resolveCache.set(key, channel);
    }
    dbSaveAlias(key, channel.id).catch(() => {});

    const hit = channelCache.get(channel.id);
    if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.payload);

    const videos = await fetchAllVideos(channel.uploads);
    const payload = { channel, videos, truncated: videos.length >= MAX_VIDEOS };
    channelCache.set(channel.id, { at: Date.now(), payload });
    res.json(payload);
    // After responding: the caller waited long enough already.
    dbSaveChannel(channel, videos).catch((err) => console.error('db save failed:', err.message));
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

// Which player client to impersonate. From a home IP any of these work; from a
// datacenter IP (Render, EC2) YouTube starts answering LOGIN_REQUIRED — its
// "confirm you're not a bot" block — and which client survives that varies, so
// try them in order rather than betting the feature on one.
const PLAYER_CLIENTS = [
  { ua: 'com.google.ios.youtube/20.10.4 (iPhone; U; CPU iOS 18_0 like Mac OS X)',
    client: { clientName: 'IOS', clientVersion: '20.10.4' } },
  { ua: 'com.google.android.youtube/20.10.38 (Linux; U; Android 15) gzip',
    client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 35 } },
  { ua: 'Mozilla/5.0',
    client: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0', clientScreen: 'EMBED' },
    thirdParty: { embedUrl: 'https://www.youtube.com' } },
  { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    client: { clientName: 'WEB', clientVersion: '2.20250101.00.00' } },
];

async function playerTracks(videoId) {
  let lastStatus = '';
  for (const c of PLAYER_CLIENTS) {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': c.ua },
      body: JSON.stringify({
        videoId,
        context: { client: { ...c.client, hl: 'en', gl: 'US' }, ...(c.thirdParty ? { thirdParty: c.thirdParty } : {}) },
      }),
    });
    if (!res.ok) { lastStatus = `player ${res.status}`; continue; }
    const data = await res.json().catch(() => null);
    const tracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (tracks?.length) return tracks;
    const status = data?.playabilityStatus?.status;
    lastStatus = status === 'LOGIN_REQUIRED' ? 'blocked by YouTube (bot check)'
      : status && status !== 'OK' ? String(status).toLowerCase()
      : 'no captions available';
  }
  throw new Error(lastStatus || 'no captions available');
}

async function fetchTranscript(videoId) {
  const tracks = await playerTracks(videoId);

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

/* ------------------------------------------------------------------ *
 * PDF
 * ------------------------------------------------------------------ */

// Inter ships with the repo so a transcript looks the same on a Mac and on
// Render. PDFKit's built-in Helvetica is Latin-1 only and has no real weights;
// the system Unicode faces stay as a fallback for scripts Inter's Latin subset
// can't draw, so a Hindi or Japanese transcript renders instead of coming out
// as rows of empty boxes.
const FONT_DIR = new URL('./assets/', import.meta.url).pathname;
const INTER = {
  regular: FONT_DIR + 'Inter-Regular.ttf',
  semibold: FONT_DIR + 'Inter-SemiBold.ttf',
  bold: FONT_DIR + 'Inter-Bold.ttf',
};
const hasInter = Object.values(INTER).every((p) => fs.existsSync(p));
const UNICODE_FONT = [
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
].find((p) => fs.existsSync(p));

// Inter's Google subset covers Latin, general punctuation and currency. Past
// that a transcript needs the wider system face.
const needsUnicode = (s) => /[^\u0020-\u024F\u2000-\u206F\u20A0-\u20BF]/.test(s || '');

const INK = '#14171F';
const MUTED = '#6B7280';
const FAINT = '#9CA3AF';
const RULE = '#E4E7EC';
const ACCENT = '#0B63CE';

// A transcript arrives as one unbroken wall of words. Chunking it on sentence
// boundaries is the difference between a document you can read and forty pages
// of grey soup.
function toParagraphs(text, perPara = 5) {
  const out = [];
  // Caption tracks mark a change of speaker with ">>". That's a genuine break
  // in the transcript, so honour it before falling back to counting sentences.
  for (const block of String(text).split(/\s*>>+\s*/)) {
    const sentences = block.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [block];
    for (let i = 0; i < sentences.length; i += perPara) {
      const para = sentences.slice(i, i + perPara).join('').trim();
      if (para) out.push(para);
    }
  }
  return out;
}

function buildPdf({ channel, items }) {
  return new Promise((resolve, reject) => {
    const M = 56;
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 64, bottom: 64, left: M, right: M },
      bufferPages: true,
      autoFirstPage: false,
      info: { Title: channel.title, Author: channel.title, Subject: 'Video transcripts for ' + channel.title },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    if (hasInter) {
      doc.registerFont('reg', INTER.regular);
      doc.registerFont('semi', INTER.semibold);
      doc.registerFont('bold', INTER.bold);
    }
    if (UNICODE_FONT) doc.registerFont('uni', UNICODE_FONT);
    const REG = hasInter ? 'reg' : 'Helvetica';
    const SEMI = hasInter ? 'semi' : 'Helvetica-Bold';
    const BOLD = hasInter ? 'bold' : 'Helvetica-Bold';
    // Falls back to the Latin face when there is no system Unicode font, which
    // at least renders something rather than throwing.
    const bodyFontFor = (text) => (needsUnicode(text) && UNICODE_FONT ? 'uni' : REG);

    const W = () => doc.page.width - M * 2;
    const pageIndex = () => doc.bufferedPageRange().count - 1;

    /* ---------------- cover ---------------- */
    doc.addPage();
    doc.font(REG).fontSize(9).fillColor(ACCENT)
      .text('TRANSCRIPT COLLECTION', { characterSpacing: 1.6 });
    doc.moveDown(1.1);
    doc.font(BOLD).fontSize(34).fillColor(INK).text(channel.title, { width: W(), lineGap: 2 });
    if (channel.handle) {
      doc.moveDown(0.3);
      doc.font(REG).fontSize(12).fillColor(MUTED).text(channel.handle);
    }

    doc.moveDown(1.4);
    const ruleY = doc.y;
    doc.save().moveTo(M, ruleY).lineTo(M + 56, ruleY).lineWidth(3).strokeColor(ACCENT).stroke().restore();

    const words = items.reduce((n, it) => n + (it.text ? it.text.trim().split(/\s+/).length : 0), 0);
    const withText = items.filter((it) => it.text).length;
    // Sit the stats on the baseline of the page rather than floating them in
    // the middle of all that white space.
    doc.y = doc.page.height - 64 - 52;
    doc.font(REG).fontSize(10.5).fillColor(MUTED);
    doc.text(withText + ' of ' + items.length + ' videos transcribed');
    doc.moveDown(0.35);
    doc.text(words.toLocaleString() + ' words');
    doc.moveDown(0.35);
    doc.text(new Date().toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' }));

    /* ----- contents: reserved now, filled once page numbers are known ----- */
    doc.addPage();
    const tocPage = pageIndex();

    /* ---------------- one entry per video ---------------- */
    const starts = [];
    items.forEach((it, i) => {
      doc.addPage();
      starts.push(pageIndex());

      doc.font(REG).fontSize(9).fillColor(FAINT).text(String(i + 1).padStart(2, '0'));
      doc.moveDown(0.45);
      doc.font(SEMI).fontSize(17).fillColor(INK).text(it.title, { width: W(), lineGap: 1.5 });

      doc.moveDown(0.5);
      const meta = [
        Number(it.views || 0).toLocaleString() + ' views',
        new Date(it.publishedAt).toLocaleDateString(undefined, { dateStyle: 'medium' }),
        it.error ? null : it.auto ? 'auto-generated captions' : 'captions',
        it.text ? it.text.trim().split(/\s+/).length.toLocaleString() + ' words' : null,
      ].filter(Boolean).join('   ·   ');
      doc.font(REG).fontSize(9).fillColor(MUTED).text(meta, { width: W() });

      doc.moveDown(0.3);
      doc.font(REG).fontSize(8.5).fillColor(ACCENT)
        .text('youtube.com/watch?v=' + it.id, {
          width: W(),
          link: 'https://www.youtube.com/watch?v=' + it.id,
          underline: false,
        });

      doc.moveDown(0.9);
      const y = doc.y;
      doc.save().moveTo(M, y).lineTo(doc.page.width - M, y).lineWidth(0.75).strokeColor(RULE).stroke().restore();
      doc.y = y + 20;

      if (it.error) {
        doc.font(REG).fontSize(10.5).fillColor(MUTED)
          .text(
            it.error === 'no captions available'
              ? 'This video has no subtitles published on YouTube, so there is no transcript to pull.'
              : 'Transcript unavailable — ' + it.error + '.',
            { width: W() }
          );
        return;
      }

      doc.font(bodyFontFor(it.text)).fontSize(10.5).fillColor(INK);
      for (const para of toParagraphs(it.text)) {
        doc.text(para, { width: W(), align: 'left', lineGap: 3.2, paragraphGap: 9 });
      }
    });

    /* ------------- contents, now that pages are known ------------- */
    doc.switchToPage(tocPage);
    doc.font(BOLD).fontSize(20).fillColor(INK).text('Contents');
    doc.moveDown(1);
    items.forEach((it, i) => {
      const top = doc.y;
      doc.font(REG).fontSize(9).fillColor(FAINT).text(String(i + 1).padStart(2, '0'), M, top, { width: 22 });
      doc.font(REG).fontSize(10.5).fillColor(INK)
        .text(it.title, M + 26, top - 1, { width: W() - 56, lineGap: 1 });
      doc.font(REG).fontSize(9.5).fillColor(FAINT)
        .text(String(starts[i] + 1), doc.page.width - M - 26, top, { width: 26, align: 'right' });
      doc.y = Math.max(doc.y, top) + 7;
    });

    /* ------------- running header and footer on every page ------------- */
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      const p = range.start + i;
      doc.switchToPage(p);
      // Writing into the margins is what they are for, but doc.text()
      // auto-paginates anything starting past the bottom margin, and that is
      // exactly what silently added a blank page per footer and doubled the
      // document. Drop the margins for the write, then put them back.
      const saved = { ...doc.page.margins };
      doc.page.margins.top = 0;
      doc.page.margins.bottom = 0;

      if (p > range.start) {
        doc.font(REG).fontSize(8).fillColor(FAINT)
          .text(channel.title, M, 30, { width: W() - 60, lineBreak: false, ellipsis: true });
        doc.save().moveTo(M, 46).lineTo(doc.page.width - M, 46)
          .lineWidth(0.5).strokeColor(RULE).stroke().restore();
        doc.font(REG).fontSize(8).fillColor(FAINT)
          .text(String(i + 1), M, doc.page.height - 40, { width: W(), align: 'center', lineBreak: false });
      }

      doc.page.margins = saved;
    }

    doc.end();
  });
}

/* ------------------------------------------------------------------ *
 * Apify fallback
 *
 * Direct fetching works from a home IP but YouTube answers LOGIN_REQUIRED
 * ("confirm you're not a bot") to datacenter IPs, so on Render every video
 * fails. Apify runs through residential proxies and isn't blocked. Tokens are
 * tried in order so a drained account rolls over to the next one.
 * ------------------------------------------------------------------ */

const APIFY_TOKENS = (process.env.APIFY_TOKENS || process.env.APIFY_TOKEN || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const APIFY_ACTOR = 'johnvc~YoutubeTranscripts';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Being cut off by YouTube is a property of the host, not of the job. Measured
// on Render, rediscovering it costs ~70s per job: every video walks four player
// clients before failing. Remember it instead, and re-test occasionally in case
// the host's standing recovers.
let directBlockedUntil = 0;
const BLOCK_MEMORY_MS = 30 * 60 * 1000;

// Don't gate the Apify fallback on a list of known block symptoms. YouTube has
// already changed shape once — it used to refuse with a 200 carrying
// LOGIN_REQUIRED, now it's a bare 403 — and the old whitelist silently stopped
// matching, so every video shipped as an error page instead of falling back.
// Anything that failed direct now gets retried; at ~$0.00001 a video, paying
// for the occasional one that genuinely has no captions costs nothing next to
// handing someone a PDF full of "blocked by YouTube".
//
// This narrower test only decides when to STOP trying direct: a transport-level
// refusal means the host is cut off and the rest will fail too, while "no
// captions available" is about that one video and says nothing about the next.
const isTransportFailure = (msg) =>
  /blocked by YouTube|rate-limited|player \d+|captions \d+|fetch failed|network/i.test(msg || '');

// How the work is cut up. A run costs roughly 20s of startup no matter how big
// it is, and about 3s per video inside it, so wall time for one chunk is
// ~20 + 3*CHUNK. Small chunks therefore finish sooner, and because every chunk
// runs at the same time, 100 videos take about as long as 5 do. Each account
// allows 16GB of concurrent actor memory against this actor's 256MB, so ~64
// runs fit per token; 8 is deliberately well under that.
// A free Apify account allows exactly 5 concurrent Actor runs. This is not in
// the limits API — maxConcurrentActorRuns reads null, and the memory ceiling
// (16GB against this actor's 256MB) suggests ~64 would fit. Exceed it and the
// run is refused with 402 concurrent-runs-limit-exceeded.
const APIFY_RUNS_PER_TOKEN = Number(process.env.APIFY_RUNS_PER_TOKEN || 5);
// Chunk size is normally derived, not fixed: see apifyTranscripts.
const APIFY_CHUNK = Number(process.env.APIFY_CHUNK || 0);

// A token that is out of credit stays out of credit, so stop dealing it into
// the rotation for the life of the process.
const deadTokens = new Set();
const liveTokens = () => APIFY_TOKENS.filter((t) => !deadTokens.has(t));

// One chunk, one run. Tries the given tokens in order so a dead or throttled
// account rolls over instead of failing the chunk.
async function apifyRun(videoIds, tokens) {
  const input = {
    youtube_url: videoIds.map((id) => `https://www.youtube.com/watch?v=${id}`),
    // No language filter. Pinning this to English dropped every video whose
    // only captions were in another language, and they were then reported as
    // having no captions at all.
    output_formats: ['text'],
    include_metadata: false,
  };

  let lastErr = '';
  for (const token of tokens) {
    try {
      let start;
      // 429 is Apify asking us to slow down, not a failure — back off in place
      // rather than burning a token rollover on it.
      for (const wait of [0, 2000, 6000, 15000]) {
        if (wait) await sleep(wait);
        start = await fetch(`https://api.apify.com/v2/acts/${APIFY_ACTOR}/runs?token=${token}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        if (start.status !== 429) break;
      }

      // 402 covers two very different things. "concurrent-runs-limit-exceeded"
      // is backpressure — the account is fine, we simply asked for too much at
      // once — and benching the token for it took all three accounts out of
      // rotation mid-job. Only a real usage limit, or 401/403, kills a token.
      if (start.status === 402 || start.status === 401 || start.status === 403) {
        const detail = await start.text().catch(() => '');
        if (/concurrent-runs-limit-exceeded/.test(detail)) {
          lastErr = 'Apify concurrency limit';
          await sleep(4000 + Math.random() * 4000);
          continue;
        }
        deadTokens.add(token);
        lastErr = `Apify token rejected (${start.status})`;
        continue;
      }
      if (!start.ok) throw new Error(`Apify start failed (${start.status})`);

      let run = (await start.json()).data;
      while (run.status === 'READY' || run.status === 'RUNNING') {
        await sleep(2000);
        const poll = await fetch(`https://api.apify.com/v2/actor-runs/${run.id}?token=${token}`);
        if (!poll.ok) throw new Error(`Apify poll failed (${poll.status})`);
        run = (await poll.json()).data;
      }
      if (run.status !== 'SUCCEEDED') {
        lastErr = `Apify run ${run.status.toLowerCase()}`;
        continue; // a run that aborts on one account may succeed on another
      }

      const items = await fetch(
        `https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?token=${token}&clean=true`
      );
      if (!items.ok) throw new Error(`Apify results failed (${items.status})`);
      return await items.json();
    } catch (err) {
      lastErr = err.message;
    }
  }
  throw new Error(lastErr || 'Apify fallback failed');
}

// Split the batch into small chunks and keep a fixed number of runs in flight
// across all the accounts at once, each worker starting on a different token so
// the load spreads. Chunks that fail outright are skipped rather than sinking
// the whole job: their videos simply come back without a transcript.
async function apifyTranscripts(videos, onCount) {
  const tokens = liveTokens();
  if (!tokens.length) throw new Error('no Apify token configured');

  // Accepts bare ids or { id, seconds }.
  const list = videos.map((v) => (typeof v === 'string' ? { id: v, seconds: 0 } : v));

  // Every run costs ~20s of startup and all of them go at once, so the job takes
  // as long as its slowest chunk. Two things follow.
  //
  // First, with a hard ceiling on runs in flight, the fastest layout is the one
  // where every chunk starts immediately: as many chunks as there are slots,
  // rather than a fixed batch size that leaves later chunks queuing.
  //
  // Second, a chunk's duration is driven by the length of the videos in it, so
  // splitting the list in order piles the long ones together. Measured on 118
  // videos, 70 were done in 32s and the last few dragged the job to 133s.
  // Dealing longest-first round-robin evens the chunks out.
  const slots = tokens.length * APIFY_RUNS_PER_TOKEN;
  const count = APIFY_CHUNK
    ? Math.ceil(list.length / APIFY_CHUNK)
    : Math.min(slots, Math.max(1, Math.ceil(list.length / 2)));

  const buckets = Array.from({ length: count }, () => []);
  [...list]
    .sort((a, b) => (b.seconds || 0) - (a.seconds || 0))
    .forEach((v, i) => buckets[i % count].push(v.id));
  const chunks = buckets.filter((b) => b.length);

  const workers = Math.min(chunks.length, slots);
  const items = [];
  const errors = [];
  const failed = [];
  let next = 0;

  await Promise.all(
    Array.from({ length: workers }, async (_, w) => {
      while (next < chunks.length) {
        const chunk = chunks[next++];
        // Start each worker on its own token, still able to fall through the
        // rest of them.
        const live = liveTokens();
        if (!live.length) { errors.push(new Error('all Apify tokens are out of credit')); return; }
        const order = [...live.slice(w % live.length), ...live.slice(0, w % live.length)];
        try {
          const got = await apifyRun(chunk, order);
          items.push(...got);
          onCount?.(chunk.length);
        } catch (err) {
          console.error('apify chunk failed:', err.message);
          errors.push(err);
          failed.push(chunk);
        }
      }
    })
  );

  // Chunks do fail under load — Apify throttles, a run aborts. Left alone they
  // become "no captions available" in the PDF, which is a lie about the video.
  // Retry them once, gently: a few at a time rather than all at once.
  if (failed.length) {
    console.error(`apify: retrying ${failed.length} failed chunk(s)`);
    let r = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, failed.length) }, async () => {
        while (r < failed.length) {
          const chunk = failed[r++];
          const live = liveTokens();
          if (!live.length) return;
          try {
            const got = await apifyRun(chunk, live);
            items.push(...got);
            onCount?.(chunk.length);
          } catch (err) {
            console.error('apify chunk failed on retry:', err.message);
          }
        }
      })
    );
  }

  if (!items.length && errors.length) throw errors[0];
  return items;
}

/* ------------------------------------------------------------------ *
 * Transcript jobs
 * ------------------------------------------------------------------ */

const jobs = new Map();
const CONCURRENCY = 2; // 4 gets you 429'd by YouTube on real-size jobs

// A video's captions don't change, and on a shared link the same popular
// videos get requested over and over. Caching them means the second run of a
// channel costs no Apify credits at all. Capped because transcripts are bulky
// and Render's free tier only has 512MB.
const transcriptCache = new Map(); // video id -> { text, lang, auto }
const TRANSCRIPT_CACHE_MAX = 400;

function rememberTranscript(id, t) {
  if (transcriptCache.size >= TRANSCRIPT_CACHE_MAX) {
    transcriptCache.delete(transcriptCache.keys().next().value); // oldest out
  }
  transcriptCache.set(id, t);
}

async function runJob(job, videos) {
  const results = new Array(videos.length);
  let next = 0;
  let blockedStreak = 0;

  // Pass 1: fetch direct. Free and instant from an unblocked IP. Once YouTube
  // has refused three in a row it will refuse all of them, so stop paying the
  // four-client round trip per video and let Apify take the rest — and
  // remember that, so the next job doesn't rediscover it the slow way.
  const hostBlocked = Date.now() < directBlockedUntil;
  if (hostBlocked) blockedStreak = 3;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, videos.length) }, async () => {
      while (next < videos.length) {
        const i = next++;
        const v = videos[i];
        const cached = transcriptCache.get(v.id);
        if (cached) {
          results[i] = { ...v, ...cached };
          job.ok++;
          job.done++;
          job.current = v.title;
          continue;
        }
        if (blockedStreak >= 3) { results[i] = { ...v, error: 'blocked by YouTube (bot check)' }; continue; }
        try {
          const t = await fetchTranscript(v.id);
          results[i] = { ...v, ...t };
          rememberTranscript(v.id, t);
          blockedStreak = 0;
          job.ok++;
          job.done++;
        } catch (err) {
          results[i] = { ...v, error: err.message };
          // Counting happens in pass 2, which decides each video's real fate.
          if (isTransportFailure(err.message)) {
            if (++blockedStreak >= 3) directBlockedUntil = Date.now() + BLOCK_MEMORY_MS;
          } else blockedStreak = 0;
        }
        job.current = v.title;
      }
    })
  );

  // Pass 2: hand everything that failed to Apify, in one batched run.
  const retry = results.filter((r) => r.error);
  if (retry.length && APIFY_TOKENS.length) {
    job.stage = 'apify';
    job.current = `Fetching ${retry.length} transcripts through Apify…`;
    // Provisional progress so the bar moves during a pass that can run for
    // minutes; the loop below then counts each video for real, so back out
    // exactly what was streamed rather than guessing.
    let streamed = 0;
    try {
      const items = await apifyTranscripts(
        retry.map((r) => ({ id: r.id, seconds: r.seconds || 0 })),
        (n) => { streamed += n; job.done += n; }
      );
      job.done -= streamed;
      const byId = new Map(items.map((it) => [it.video_id, it]));
      for (const r of retry) {
        const hit = byId.get(r.id);
        const text = (hit?.non_timestamped || hit?.text || '').replace(/\s+/g, ' ').trim();
        const idx = results.indexOf(r);
        if (text) {
          const t = { text, lang: hit.language_code, auto: !!hit.is_generated };
          results[idx] = { ...r, error: undefined, ...t };
          rememberTranscript(r.id, t);
          job.ok++;
        } else {
          results[idx] = { ...r, error: 'no captions available' };
          job.failed++;
        }
        job.done++;
      }
    } catch (err) {
      job.done -= streamed;
      for (const r of retry) { job.failed++; job.done++; r.error = err.message; }
    }
  } else {
    for (const r of retry) { job.failed++; job.done++; }
  }

  for (const r of results) if (r.error) job.reasons[r.error] = (job.reasons[r.error] || 0) + 1;

  job.stage = 'building';
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
  const job = { id, channel, total: videos.length, done: 0, ok: 0, failed: 0, status: 'running', current: '', stage: 'direct', reasons: {} };
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
  const { id, total, done, ok, failed, status, current, error, reasons, stage } = job;
  res.json({ id, total, done, ok, failed, status, current, error, reasons, stage, ready: status === 'done' });
});

app.get('/api/transcripts/:id/pdf', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.pdf) return res.status(404).send('Not ready.');
  const name = job.channel.title.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-') || 'transcripts';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-transcripts.pdf"`);
  res.send(job.pdf);
});

app.get('/api/config', (_req, res) =>
  res.json({ hasKey: !!API_KEY, apifyTokens: APIFY_TOKENS.length, db: !!pool, cached: { channels: channelCache.size, transcripts: transcriptCache.size } })
);

// Only listen when run as the entrypoint, so test.mjs can import the helpers.
// argv[1] is undefined under `node -e`, and pathToFileURL throws on undefined.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  initDb().catch((err) => console.error('db init failed:', err.message));

  app.listen(PORT, () => {
    console.log(`YouTube Outlier  →  http://localhost:${PORT}`);
    if (!API_KEY) console.log('⚠  YOUTUBE_API_KEY missing — add it to .env, then restart.');
  });
}

export { parseDuration, median, fetchTranscript, buildPdf, apifyTranscripts, app };
