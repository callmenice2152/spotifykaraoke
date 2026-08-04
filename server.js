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

// Backend Lyrics Fetcher (LRCLIB + QQ Music) - Avoids browser CORS & forbidden header restrictions
async function getSyncedLyricsBackend(trackName, artistName) {
  const cleanTrack = trackName
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/-.*/g, '')
    .trim() || trackName;
  const cleanArtist = artistName.split(',')[0].trim();

  // 1. Try LRCLIB /api/get
  try {
    const getUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(cleanTrack)}&artist_name=${encodeURIComponent(cleanArtist)}`;
    const resGet = await fetch(getUrl);
    if (resGet.ok) {
      const data = await resGet.json();
      if (data.syncedLyrics && data.syncedLyrics.length > 20) {
        return data.syncedLyrics;
      }
    }
  } catch (err) {}

  // 2. Try QQ Music API
  try {
    const query = cleanArtist + ' ' + cleanTrack;
    const searchUrl = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(query)}&format=json&p=1&n=5`;
    const res = await fetch(searchUrl, {
      headers: { 'Referer': 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (res.ok) {
      const data = await res.json();
      const songs = data.data?.song?.list || [];
      for (let song of songs) {
        if (song.songmid) {
          const lyricUrl = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${song.songmid}&format=json&nobase64=1`;
          const lRes = await fetch(lyricUrl, {
            headers: { 'Referer': 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0' }
          });
          if (lRes.ok) {
            const lData = await lRes.json();
            const lrc = lData.lyric;
            if (lrc && lrc.includes('[')) {
              return lrc;
            }
          }
        }
      }
    }
  } catch (err) {}

  // 3. Try LRCLIB search fallback
  try {
    const qUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(cleanArtist + ' ' + cleanTrack)}`;
    const resQ = await fetch(qUrl);
    if (resQ.ok) {
      const list = await resQ.json();
      const syncedItem = list.find(i => i.syncedLyrics && i.syncedLyrics.length > 20);
      if (syncedItem) return syncedItem.syncedLyrics;
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
