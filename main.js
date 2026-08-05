const { app, BrowserWindow, globalShortcut, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow = null;
let lyricsWindow = null;
let tray = null;
let serverProcess = null;

// Start Express Server
function startServer() {
  serverProcess = spawn('node', ['server.js'], {
    cwd: __dirname,
    stdio: 'ignore'
  });
}

app.commandLine.appendSwitch('disable-background-timer-throttling');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 220, // Default compact height matching design!
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    show: false, // Start hidden until ready
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  });

  // Open external links (like Spotify/Facebook login) in default system browser (Chrome/Edge)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('spotify.com') || url.includes('facebook.com')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Load the web app
  mainWindow.loadURL('http://127.0.0.1:3000');

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Hide on close instead of destroying
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

// Create Floating Transparent Lyrics Window
function createLyricsWindow() {
  lyricsWindow = new BrowserWindow({
    width: 200,
    height: 24,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    show: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  });

  // Load the lyrics page
  lyricsWindow.loadURL('http://127.0.0.1:3000/lyrics.html');

  // Auto-show on launch once ready
  lyricsWindow.once('ready-to-show', () => {
    lyricsWindow.show();
  });

  lyricsWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      lyricsWindow.hide();
    }
  });
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function toggleLyricsWindow() {
  if (!lyricsWindow) return;
  if (lyricsWindow.isVisible()) {
    lyricsWindow.hide();
  } else {
    lyricsWindow.show();
  }
}

// IPC Listener to dynamically resize window height when search expands/collapses
ipcMain.on('resize-window', (event, height) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const [width] = mainWindow.getSize();
    mainWindow.setSize(width, height, true);
  }
});

// IPC Listener to update the lyrics text in the floating lyrics window
ipcMain.on('update-lyric-text', (event, text) => {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.webContents.send('lyric-update', text);
  }
});

// IPC Listener to sync sneak mode with floating lyrics window
ipcMain.on('sync-sneak-mode', (event, isSneak) => {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.webContents.send('toggle-sneak-mode', isSneak);
  }
});

// IPC Listener to dynamically resize lyricsWindow to fit exact text dimensions
ipcMain.on('resize-lyrics-window', (event, { width, height }) => {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    const w = Math.max(60, Math.ceil(width));
    const h = Math.max(18, Math.ceil(height));
    lyricsWindow.setSize(w, h, false);
  }
});

function parseAndMergeLrc(rawLrc) {
  if (!rawLrc) return null;
  if (rawLrc.includes('此歌曲为') || rawLrc.includes('纯音乐') || rawLrc.includes('暂无歌词')) {
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
      const text = match[4].trim();
      const timeMs = (min * 60 + sec) * 1000 + ms;
      if (text && !text.includes('Written by') && !text.includes('Composed by')) {
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
  const artistNorm = norm(targetArtist);
  const isTargetRemix = targetNorm.includes('misscall') || targetNorm.includes('acoustic') || targetNorm.includes('remix') || targetNorm.includes('live') || targetNorm.includes('cover') || targetNorm.includes('ver');

  let bestSong = null;
  let bestScore = 0;

  for (let song of songs) {
    const songTitle = song.songtitle || song.songname || '';
    const songNorm = norm(songTitle);
    const singerList = (song.singer || []).map(s => norm(s.name || '')).join('');
    const isSongRemix = songNorm.includes('misscall') || songNorm.includes('acoustic') || songNorm.includes('remix') || songNorm.includes('live') || songNorm.includes('cover') || songNorm.includes('ver');

    let score = 0;
    if (songNorm === targetNorm) score += 50;
    else if (songNorm.includes(targetNorm) || targetNorm.includes(songNorm)) score += 30;

    // Artist verification (+50 if artist matches, -40 penalty if artist mismatches)
    if (artistNorm && (singerList.includes(artistNorm) || artistNorm.includes(singerList))) {
      score += 50;
    } else {
      score -= 40;
    }

    // Penalty if song has remix/version tag but Spotify track does NOT
    if (!isTargetRemix && isSongRemix) score -= 30;

    if (score > bestScore) {
      bestScore = score;
      bestSong = song;
    }
  }
  // Require high confidence score (score >= 50)
  return bestScore >= 50 ? bestSong : null;
}

// Native Node.js Lyrics Engine (LRCLIB + QQ Music) for 100% Thai & International Coverage
async function getSyncedLyricsBackend(trackName, artistName) {
  const cleanTrack = trackName
    .replace(/\([^)]*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/-.*/g, '')
    .trim() || trackName;
  const cleanArtist = artistName.split(',')[0].trim();

  // 0. Check local_lyrics.json custom overrides first
  try {
    const fs = require('fs');
    const path = require('path');
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
        console.log('Using local lyrics override for:', trackName);
        if (Array.isArray(matchedLyrics)) {
          return parseAndMergeLrc(matchedLyrics.join('\n'));
        } else if (typeof matchedLyrics === 'string') {
          return parseAndMergeLrc(matchedLyrics);
        }
      }
    }
  } catch (err) {
    console.error('Error reading local lyrics override:', err);
  }

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
      const syncedItem = list.find(i => i.syncedLyrics && i.syncedLyrics.length > 20);
      if (syncedItem) {
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
  } catch (err) {}

  return null;
}

// IPC Handle for Lyrics Fetching directly from Electron Main Node Process
ipcMain.handle('get-lyrics', async (event, { track, artist }) => {
  if (!track || !artist) return null;
  return await getSyncedLyricsBackend(track, artist);
});

// IPC Listener to toggle the lyrics window from the renderer UI
ipcMain.on('toggle-lyrics-view', () => {
  toggleLyricsWindow();
});

function createTray() {
  try {
    const iconPath = path.join(__dirname, 'public', 'icon.png');
    let icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      icon = nativeImage.createEmpty();
    }

    tray = new Tray(icon);
    const contextMenu = Menu.buildFromTemplate([
      { label: '🎵 Show / Hide Sneak Bar (Alt+Space)', click: () => toggleWindow() },
      { label: '🎤 Show / Hide Lyrics Overlay (Alt+L / Alt+\\)', click: () => toggleLyricsWindow() },
      { label: '📌 Toggle Always on Top', type: 'checkbox', checked: true, click: (menuItem) => {
        if (mainWindow) mainWindow.setAlwaysOnTop(menuItem.checked);
      }},
      { type: 'separator' },
      { label: '❌ Exit', click: () => {
        app.isQuitting = true;
        app.quit();
      }}
    ]);

    tray.setToolTip('Spotify Command');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => toggleWindow());
  } catch (err) {
    console.error('Tray creation error:', err);
  }
}

app.whenReady().then(() => {
  startServer();
  
  // Wait 1 sec for Express server to start, then load windows
  setTimeout(() => {
    createWindow();
    createLyricsWindow();
    createTray();
  }, 1000);

  // Register Global Hotkeys
  try {
    globalShortcut.register('Alt+Shift+S', () => {
      toggleWindow();
    });

    globalShortcut.register('Alt+Space', () => {
      toggleWindow();
    });

    // Register Hotkeys for Lyrics Toggle (Alt+L & Alt+\)
    globalShortcut.register('Alt+L', () => {
      toggleLyricsWindow();
    });
    globalShortcut.register('Alt+\\', () => {
      toggleLyricsWindow();
    });
  } catch (err) {
    console.error('Shortcut registration error:', err);
  }
});

app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll();
  } catch (err) {}
  if (serverProcess) serverProcess.kill();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
