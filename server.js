require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_FILE = path.join(__dirname, 'session.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Public Config Endpoint (Reads SPOTIFY_CLIENT_ID from .env if present)
app.get('/api/config', (req, res) => {
  res.json({
    clientId: process.env.SPOTIFY_CLIENT_ID || ''
  });
});

// Save Token Endpoint
app.post('/api/save-session', (req, res) => {
  try {
    const sessionData = req.body;
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Token Endpoint
app.get('/api/get-session', (req, res) => {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const data = fs.readFileSync(SESSION_FILE, 'utf8');
      return res.json(JSON.parse(data));
    }
  } catch (err) {}
  res.json({});
});

// Clear Session Endpoint
app.post('/api/clear-session', (req, res) => {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
  } catch (err) {}
  res.json({ success: true });
});

function parseAndMergeLrc(rawLrc) {
  if (!rawLrc) return null;
  if (rawLrc.includes('此歌曲为') || rawLrc.includes('纯音乐') || rawLrc.includes('暂无歌词')) {
    return null;
  }
  // Reject pure Korean lyrics if no Thai characters are present
  if (/[\uac00-\ud7af]/.test(rawLrc) && !/[\u0E00-\u0E7F]/.test(rawLrc)) {
    return null;
  }
  const decoded = rawLrc
    .replace(/&#58;/g, ':')
    .replace(/&#46;/g, '.')
    .replace(/&#10;/g, '\n')
    .replace(/&#32;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');

  const lines = decoded.split('\n');
  const rawList = [];
  const timeRegex = /^\[(\d+):(\d+)(?:\.|:)(\d+)\](.*)/;

  for (let line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[ti:') || trimmed.startsWith('[ar:') || trimmed.startsWith('[al:') || trimmed.startsWith('[by:') || trimmed.startsWith('[offset:')) continue;
    const match = timeRegex.exec(trimmed);
    if (match) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = parseInt(match[3].padEnd(3, '0').substring(0, 3), 10);
      let text = match[4].trim();
      text = text.replace(/\[\d+:\d+(?:\.|\:)\d+\]/g, '').trim();

      const timeMs = (min * 60 + sec) * 1000 + ms;
      if (text && !text.includes('Written by') && !text.includes('Composed by') && !text.includes('Lyrics by')) {
        rawList.push({ timeMs, text });
      }
    }
  }
  rawList.sort((a, b) => a.timeMs - b.timeMs);

  const mergedList = [];
  let currentGroup = null;

  for (let i = 0; i < rawList.length; i++) {
    const item = rawList[i];
    if (!currentGroup) {
      currentGroup = { timeMs: item.timeMs, text: item.text };
    } else {
      const timeDiff = item.timeMs - currentGroup.timeMs;
      if (timeDiff <= 1500 && (currentGroup.text.length + item.text.length) <= 50) {
        currentGroup.text += ' ' + item.text;
      } else {
        mergedList.push(currentGroup);
        currentGroup = { timeMs: item.timeMs, text: item.text };
      }
    }
  }
  if (currentGroup) mergedList.push(currentGroup);

  return mergedList.map(item => {
    const totalSec = Math.floor(item.timeMs / 1000);
    const min = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const sec = String(totalSec % 60).padStart(2, '0');
    const ms = String(item.timeMs % 1000).padStart(3, '0').substring(0, 2);
    return `[${min}:${sec}.${ms}] ${item.text}`;
  }).join('\n');
}

function pickBestSongMatch(songs, targetTrack, targetArtist, targetDurationSec = null) {
  if (!songs || songs.length === 0) return null;
  const norm = str => (str || '').toLowerCase().replace(/\s+/g, '').replace(/[^\w\u0E00-\u0E7F]/g, '');
  const targetNorm = norm(targetTrack);
  const cleanTrackNorm = norm(targetTrack.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').replace(/-.*/g, '').trim());
  const artistNorm = norm(targetArtist);
  const isTargetRemix = targetNorm.includes('misscall') || targetNorm.includes('acoustic') || targetNorm.includes('remix') || targetNorm.includes('live') || targetNorm.includes('cover') || targetNorm.includes('ver') || targetNorm.includes('edit');

  let bestSong = null;
  let bestScore = -999;

  for (let song of songs) {
    if (!song.syncedLyrics && !song.lyric && !song.fyc) continue;
    const songTitle = song.trackName || song.songtitle || song.songname || '';
    const songNorm = norm(songTitle);
    const singerList = Array.isArray(song.singer)
      ? song.singer.map(s => norm(s.name || '')).join('')
      : norm(song.artistName || '');
    const isSongRemix = songNorm.includes('misscall') || songNorm.includes('acoustic') || songNorm.includes('remix') || songNorm.includes('live') || songNorm.includes('cover') || songNorm.includes('ver') || songNorm.includes('edit');

    let score = 0;
    if (songNorm === targetNorm) {
      score += 100;
    } else if (songNorm === cleanTrackNorm) {
      score += 80;
    } else if (songNorm.includes(cleanTrackNorm) || cleanTrackNorm.includes(songNorm)) {
      score += 40;
      if (songNorm.includes('express') && !targetNorm.includes('express')) score -= 60;
    } else {
      score -= 50;
    }

    if (artistNorm && (singerList.includes(artistNorm) || artistNorm.includes(singerList))) {
      score += 50;
    } else {
      score -= 40;
    }

    if (isTargetRemix && isSongRemix) score += 30;
    if (!isTargetRemix && isSongRemix) score -= 30;

    // Penalty for Music Video versions if target is not MV
    if (!targetNorm.includes('video') && !targetNorm.includes('mv') && (songNorm.includes('officialvideo') || songNorm.includes('musicvideo') || songNorm.includes('video') || songNorm.includes('mv'))) {
      score -= 40;
    }

    // Duration matching bonus & penalty
    const songDurationSec = song.duration || song.interval;
    if (targetDurationSec && songDurationSec) {
      const diff = Math.abs(songDurationSec - targetDurationSec);
      if (diff <= 3) {
        score += 60;
      } else if (diff <= 6) {
        score += 30;
      } else if (diff > 10) {
        score -= 40;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestSong = song;
    }
  }
  return bestScore >= 50 ? bestSong : null;
}

// Systemic Dynamic Thai Lyric Polisher (Auto-fixes machine translation glitches for ALL songs)
function polishThaiTranslation(originalEng, rawThai) {
  if (!rawThai) return '';
  let orig = (originalEng || '').toLowerCase();
  let text = rawThai;

  const isHipHop = orig.includes('nigga') || orig.includes('bitch') || orig.includes('shot') || orig.includes('snitched') || orig.includes('doubted') || orig.includes('money') || orig.includes('problems') || orig.includes('lawyers');

  // Fix common Google Translate machine glitches across ALL songs automatically
  text = text.replace(/ขอบคุณนะ ต่อไป|ขอบคุณนะ ถัดไป|ขอบเธอ ต่อไป|ขอบเธอ ถัดไป|ขอบใจนะ ต่อไป|ขอบใจนะ ถัดไป/gi, 'ขอบคุณนะ... คนต่อไป!');
  text = text.replace(/ขอบเธอ|ขอบคุณ u|ขอบใจ u/gi, 'ขอบคุณนะ');
  text = text.replace(/ถัดไป/gi, 'คนต่อไป');
  text = text.replace(/ผีของคุณ|ผีเธอ/gi, 'ภาพทรงจำเก่าๆ');
  text = text.replace(/คนที่ถูกตำหนิ/gi, 'ฝ่ายที่ผิดเอง');
  text = text.replace(/ฉันเดาว่า/gi, 'สงสัย');
  text = text.replace(/F\*ck คุณ|เย็ดคุณ|เย็ดมึง/gi, 'ค*ยเหอะ');
  text = text.replace(/เด็กน้อย|ทารก/gi, 'เธอ');
  text = text.replace(/นกสองหัว|ยีนส์|ประเภทเมีย/gi, 'ยัยตัวดี');
  text = text.replace(/ผู้อพยพ|ผู้หลบหนี/gi, 'คนหลบหนี');
  text = text.replace(/กะเทย|กระเทย/gi, 'พวกมัน');
  text = text.replace(/ตรงไป/gi, 'พูดจริงไม่ได้อำ');
  text = text.replace(/หัวใจแตกสลาย/gi, 'อกหักว่ะ');

  // Genre-based pronoun handling
  if (isHipHop) {
    text = text.replace(/คุณ/gi, 'มึง');
    text = text.replace(/ฉัน/gi, 'กู');
  } else {
    text = text.replace(/คุณ/gi, 'เธอ');
    text = text.replace(/กู/gi, 'ฉัน');
  }

  return text.trim();
}

const translationCache = {};

function httpsGet(url, headers = {}) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', ...headers } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', () => resolve({ status: 500, body: '' }));
  });
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));
}

async function translateTextBackend(text) {
  if (!text || !text.trim()) return '';
  const trimmed = text.trim();

  if (/[\u0E00-\u0E7F]/.test(trimmed)) return '';

  const cleanEng = trimmed.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').trim() || trimmed;
  const normKey = cleanEng.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim() || cleanEng.toLowerCase().trim();
  if (normKey && translationCache[normKey]) return translationCache[normKey];

  try {
    const transPath = path.join(__dirname, 'local_translations.json');
    if (fs.existsSync(transPath)) {
      const localTrans = JSON.parse(fs.readFileSync(transPath, 'utf8'));
      for (const k of Object.keys(localTrans)) {
        const normK = k.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim() || k.toLowerCase().trim();
        if (normK === normKey || (normKey.length >= 4 && normK.length >= 4 && (normKey.includes(normK) || normK.includes(normKey)))) {
          translationCache[normKey] = localTrans[k];
          return localTrans[k];
        }
      }
    }
  } catch (err) {}

  // 1. Provider 1: Google Web Mobile (fast, unthrottled)
  try {
    const url1 = 'https://translate.google.com/m?sl=auto&tl=th&q=' + encodeURIComponent(cleanEng);
    const res1 = await httpsGet(url1);
    if (res1.status === 200) {
      const match = res1.body.match(/class="result-container">([^<]+)/) || res1.body.match(/class="t0">([^<]+)/);
      if (match && match[1]) {
        const rawThai = decodeHtmlEntities(match[1].trim());
        const polished = polishThaiTranslation(cleanEng, rawThai);
        if (polished) {
          translationCache[normKey] = polished;
          return polished;
        }
      }
    }
  } catch (err) {}

  // 2. Provider 2: Google Translate GTX Endpoint
  try {
    const url2 = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=th&dt=t&q=${encodeURIComponent(cleanEng)}`;
    const res2 = await httpsGet(url2);
    if (res2.status === 200) {
      const data = JSON.parse(res2.body);
      const rawThai = data[0]?.map(item => item[0]).join('') || '';
      const polished = polishThaiTranslation(cleanEng, rawThai);
      if (polished) {
        translationCache[normKey] = polished;
        return polished;
      }
    }
  } catch (err) {}

  // 3. Provider 3: MyMemory API (Reliable Fallback)
  try {
    const url3 = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(cleanEng) + '&langpair=en|th';
    const res3 = await httpsGet(url3);
    if (res3.status === 200) {
      const data = JSON.parse(res3.body);
      const rawThai = data?.responseData?.translatedText || '';
      if (rawThai && !rawThai.includes('MYMEMORY WARNING')) {
        const polished = polishThaiTranslation(cleanEng, decodeHtmlEntities(rawThai));
        if (polished) {
          translationCache[normKey] = polished;
          return polished;
        }
      }
    }
  } catch (err) {}

  return '';
}

// Backend Lyrics Fetcher (LRCLIB + QQ Music)
async function getSyncedLyricsBackend(trackName, artistName, targetDurationSec = null) {
  const cleanTrack = trackName
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/-.*/g, '')
    .trim() || trackName;
  const cleanArtist = artistName.split(',')[0].trim();

  // 0. Check local_lyrics.json custom overrides first
  try {
    const localPath = path.join(__dirname, 'local_lyrics.json');
    if (fs.existsSync(localPath)) {
      const localData = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      const normTrack = trackName.toLowerCase().replace(/\s+/g, '');
      const normCleanTrack = cleanTrack.toLowerCase().replace(/\s+/g, '');
      
      let matchedLyrics = null;
      for (const k of Object.keys(localData)) {
        const normK = k.toLowerCase().replace(/\s+/g, '');
        if (normK.includes(normTrack) || normK.includes(normCleanTrack)) {
          matchedLyrics = localData[k];
          break;
        }
      }
      
      if (matchedLyrics) {
        if (Array.isArray(matchedLyrics)) {
          return parseAndMergeLrc(matchedLyrics.join('\n'));
        } else if (typeof matchedLyrics === 'string') {
          return parseAndMergeLrc(matchedLyrics);
        }
      }
    }
  } catch (err) {}

  // 1. Try LRCLIB search with full track name (with Edit/Remix tag & duration matching)
  try {
    const qUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanArtist + ' ' + trackName)}`;
    const resQ = await fetch(qUrl);
    if (resQ.ok) {
      const list = await resQ.json();
      const syncedItem = pickBestSongMatch(list, trackName, artistName, targetDurationSec);
      if (syncedItem && syncedItem.syncedLyrics) {
        const parsed = parseAndMergeLrc(syncedItem.syncedLyrics);
        if (parsed) return parsed;
      }
    }
  } catch (err) {}

  // 2. Try LRCLIB /api/get with cleanTrack
  try {
    const getUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(cleanTrack)}&artist_name=${encodeURIComponent(cleanArtist)}`;
    const resGet = await fetch(getUrl);
    if (resGet.ok) {
      const data = await resGet.json();
      if (data.syncedLyrics && data.syncedLyrics.length > 20) {
        const parsed = parseAndMergeLrc(data.syncedLyrics);
        if (parsed) return parsed;
      }
    }
  } catch (err) {}

  // 2. Try LRCLIB search (100% Clean Thai & International Synced Lyrics)
  try {
    const qUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanArtist + ' ' + cleanTrack)}`;
    const resQ = await fetch(qUrl);
    if (resQ.ok) {
      const list = await resQ.json();
      const syncedItem = pickBestSongMatch(list, trackName, artistName);
      if (syncedItem && syncedItem.syncedLyrics) {
        const parsed = parseAndMergeLrc(syncedItem.syncedLyrics);
        if (parsed) return parsed;
      }
    }
  } catch (err) {}

  // 3. Try QQ Music API with Smart Original vs Remix Matching
  try {
    const queries = [
      cleanArtist + ' ' + trackName,
      cleanArtist + ' ' + cleanTrack,
      trackName,
      cleanTrack
    ];

    for (let q of queries) {
      const searchUrl = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(q)}&format=json&p=1&n=5`;
      const res = await fetch(searchUrl, {
        headers: { 'Referer': 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' }
      });
      if (res.ok) {
        const data = await res.json();
        const songs = data.data?.song?.list || [];
        const bestSong = pickBestSongMatch(songs, trackName, artistName);
        if (bestSong && bestSong.songmid) {
          const lyricUrl = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${bestSong.songmid}&format=json&nobase64=1`;
          const lRes = await fetch(lyricUrl, {
            headers: { 'Referer': 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' }
          });
          if (lRes.ok) {
            const lData = await lRes.json();
            const lrc = lData.lyric;
            if (lrc && lrc.includes('[')) {
              const parsed = parseAndMergeLrc(lrc);
              if (parsed) return parsed;
            }
          }
        }
      }
    }
  } catch (err) {}

  return null;
}

app.get('/api/lyrics', async (req, res) => {
  const { track, artist, duration } = req.query;
  if (!track || !artist) return res.json({ lyrics: null });
  const lyrics = await getSyncedLyricsBackend(track, artist, duration ? parseFloat(duration) : null);
  res.json({ lyrics });
});

app.get('/api/translate', async (req, res) => {
  const { text } = req.query;
  if (!text) return res.json({ translation: '' });
  const translation = await translateTextBackend(text);
  res.json({ translation });
});

// Direct OAuth Callback Handler with Automatic PKCE Token Exchange
app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (code) {
    try {
      let verifier = '';
      const pkceFile = path.join(__dirname, 'pkce_temp.json');
      if (fs.existsSync(pkceFile)) {
        const pkce = JSON.parse(fs.readFileSync(pkceFile, 'utf8'));
        verifier = pkce.verifier;
      }
      if (verifier) {
        const bodyParams = new URLSearchParams({
          client_id: '62e388ea4f4b4a64898da6d4a15281f0',
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: 'http://127.0.0.1:3000/callback',
          code_verifier: verifier
        });
        const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: bodyParams.toString()
        });
        const tokenData = await tokenRes.json();
        if (tokenData.access_token) {
          const sessionData = {
            spotify_access_token: tokenData.access_token,
            spotify_refresh_token: tokenData.refresh_token,
            spotify_client_id: '62e388ea4f4b4a64898da6d4a15281f0',
            spotify_redirect_uri: 'http://127.0.0.1:3000/callback'
          };
          fs.writeFileSync(SESSION_FILE, JSON.stringify(sessionData, null, 2));
          console.log('✅ Successfully authorized with full playlist scopes!');
          return res.send(`
            <html>
            <head><meta charset="utf-8"><title>Spotify Connected</title></head>
            <body style="background:#121212;color:#10b981;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;">
              <h1 style="margin-bottom:8px;">✅ อัปเดตสิทธิ์ Playlist สำเร็จเรียบร้อยแล้ว!</h1>
              <p style="color:#e5e7eb;font-size:16px;">ระบบพร้อมเพิ่มเพลงลงใน Playlist ของคุณแล้ว สามารถปิดหน้านี้ได้เลยครับ</p>
            </body>
            </html>
          `);
        }
      }
    } catch (e) {
      console.error('Server OAuth Callback error:', e);
    }
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve index.html for all SPA routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`==================================================`);
    console.log(`🎵 Spotify Stealth Quick Bar is running!`);
    console.log(`👉 Open: http://127.0.0.1:${PORT}`);
    console.log(`==================================================`);
  });
}

module.exports = {
  app,
  getSyncedLyricsBackend,
  translateTextBackend,
  pickBestSongMatch
};
