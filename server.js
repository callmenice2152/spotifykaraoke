require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

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

function pickBestSongMatch(songs, targetTrack, targetArtist) {
  if (!songs || songs.length === 0) return null;
  const norm = str => (str || '').toLowerCase().replace(/\s+/g, '').replace(/[^\w\u0E00-\u0E7F]/g, '');
  const targetNorm = norm(targetTrack);
  const cleanTrackNorm = norm(targetTrack.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').replace(/-.*/g, '').trim());
  const artistNorm = norm(targetArtist);
  const isTargetRemix = targetNorm.includes('misscall') || targetNorm.includes('acoustic') || targetNorm.includes('remix') || targetNorm.includes('live') || targetNorm.includes('cover') || targetNorm.includes('ver');

  let bestSong = null;
  let bestScore = -999;

  for (let song of songs) {
    const songTitle = song.trackName || song.songtitle || song.songname || '';
    const songNorm = norm(songTitle);
    const singerList = Array.isArray(song.singer)
      ? song.singer.map(s => norm(s.name || '')).join('')
      : norm(song.artistName || '');
    const isSongRemix = songNorm.includes('misscall') || songNorm.includes('acoustic') || songNorm.includes('remix') || songNorm.includes('live') || songNorm.includes('cover') || songNorm.includes('ver');

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

    if (!isTargetRemix && isSongRemix) score -= 30;

    if (score > bestScore) {
      bestScore = score;
      bestSong = song;
    }
  }
  return bestScore >= 50 ? bestSong : null;
}

// Real Raw Street Translation Engine (Emo Rap / Hip-Hop Trained with มึง/มัน/กู)
function polishThaiTranslation(originalEng, rawThai) {
  if (!rawThai) return '';
  let orig = (originalEng || '').toLowerCase();
  let text = rawThai;

  // Real Raw Street Context Rules
  if (orig.includes('put my heart in the bag') && orig.includes('nobody gets hurt')) {
    return 'มันบอกให้กูเอาใจใส่กระเป๋าไว้ ถ้าไม่อยากเจ็บตัว';
  }
  if (orig.includes('running from her love') || orig.includes('i\'m a fugitive')) {
    return 'ตอนนี้กูต้องวิ่งหนีรักของมึง กลายเป็นคนหลบหนีไปละ';
  }
  if (orig.includes('in my feelings')) {
    return 'ตอนนี้กูโคตรดิ่งเลย รู้สึกโหว่ๆ ในใจ';
  }
  if (orig.includes('feel a hole')) {
    return 'ทำกูรู้สึกโหว่ๆ ในใจชิปหาย';
  }
  if (orig.includes('pour a four')) {
    return 'เทยา/เหล้าผสมกินแม่มเลย';
  }

  // Raw Street Pronoun & Phrasing Replacements (มึง / มัน / กู)
  text = text.replace(/ผีของคุณ|ผีเธอ/gi, 'ภาพทรงจำเก่าๆ ของมึง');
  text = text.replace(/คนที่ถูกตำหนิ/gi, 'ฝ่ายที่ผิดเอง');
  text = text.replace(/ฉันเดาว่า/gi, 'สงสัย');
  text = text.replace(/F\*ck คุณ|เย็ดคุณ|เย็ดมึง/gi, 'ค*ยเหอะ');
  text = text.replace(/เด็กน้อย|ทารก/gi, 'มึง');
  text = text.replace(/นกสองหัว|ยีนส์|ประเภทเมีย/gi, 'อีตัวดี');
  text = text.replace(/ผู้อพยพ|ผู้หลบหนี/gi, 'คนหลบหนี');
  text = text.replace(/คุณ/gi, 'มึง');
  text = text.replace(/เธอ/gi, 'มึง');
  text = text.replace(/ฉัน/gi, 'กู');
  text = text.replace(/บอกลา/gi, 'บาย');
  text = text.replace(/หัวใจแตกสลาย/gi, 'อกหักว่ะ');

  return text.trim();
}

const translationCache = {};

async function translateTextBackend(text) {
  if (!text || !text.trim()) return '';
  const trimmed = text.trim();

  if (/[\u0E00-\u0E7F]/.test(trimmed)) return '';

  const normKey = trimmed.toLowerCase().replace(/[^\w\s]/g, '').trim();
  if (translationCache[normKey]) return translationCache[normKey];

  try {
    const transPath = path.join(__dirname, 'local_translations.json');
    if (fs.existsSync(transPath)) {
      const localTrans = JSON.parse(fs.readFileSync(transPath, 'utf8'));
      for (const k of Object.keys(localTrans)) {
        const normK = k.toLowerCase().replace(/[^\w\s]/g, '').trim();
        if (normK === normKey || normKey.includes(normK)) {
          translationCache[normKey] = localTrans[k];
          return localTrans[k];
        }
      }
    }
  } catch (err) {}

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=th&dt=t&q=${encodeURIComponent(trimmed)}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const rawThai = data[0]?.map(item => item[0]).join('') || '';
      const polished = polishThaiTranslation(trimmed, rawThai);
      if (polished) {
        translationCache[normKey] = polished;
        return polished;
      }
    }
  } catch (err) {}

  return '';
}

// Backend Lyrics Fetcher (LRCLIB + QQ Music)
async function getSyncedLyricsBackend(trackName, artistName) {
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

  // 1. Try LRCLIB /api/get
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
  const { track, artist } = req.query;
  if (!track || !artist) return res.json({ lyrics: null });
  const lyrics = await getSyncedLyricsBackend(track, artist);
  res.json({ lyrics });
});

app.get('/api/translate', async (req, res) => {
  const { text } = req.query;
  if (!text) return res.json({ translation: '' });
  const translation = await translateTextBackend(text);
  res.json({ translation });
});

// Serve index.html for all SPA routes / callback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`==================================================`);
  console.log(`🎵 Spotify Stealth Quick Bar is running!`);
  console.log(`👉 Open: http://127.0.0.1:${PORT}`);
  console.log(`==================================================`);
});
