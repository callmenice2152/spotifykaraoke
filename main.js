const { app, BrowserWindow, globalShortcut, Tray, Menu, nativeImage, shell, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const { app: expressApp, translateTextBackend } = require('./server');

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log('[App] Another instance is already running. Quitting duplicate.');
  app.quit();
  process.exit(0);
}

let mainWindow = null;
let lyricsWindow = null;
let tray = null;
let serverProcess = null;

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.show();
  }
});

// Start Express Server
function startServer() {
  try {
    expressApp.listen(3000, '0.0.0.0', () => {
      console.log('Express server running on http://127.0.0.1:3000');
    }).on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log('Port 3000 is already in use, reusing existing server.');
      } else {
        console.error('Express server error:', err);
      }
    });
  } catch (err) {
    console.error('Failed to start express server:', err);
  }
}

app.commandLine.appendSwitch('disable-background-timer-throttling');

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
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

const LYRICS_POS_FILE = path.join(__dirname, 'lyrics_position.json');
let userCustomCenterX = null;
let isProgrammaticResize = false;

// Get Work Area in Electron DIP coordinates
function getWorkArea() {
  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    return primaryDisplay.workArea || { x: 0, y: 0, width: 1536, height: 960 };
  } catch (err) {
    return { x: 0, y: 0, width: 1536, height: 960 };
  }
}

// Calculate default Bottom-Center position dynamically based on display work area
function getDefaultLyricsPosition(windowWidth = 240, windowHeight = 32) {
  const workArea = getWorkArea();
  const screenCenterX = Math.round(workArea.x + workArea.width / 2);
  const x = Math.round(screenCenterX - windowWidth / 2);
  // Position ~75px above bottom edge of work area (comfortably above taskbar)
  const y = Math.max(50, Math.round(workArea.y + workArea.height - 75));
  return { x, y };
}

function loadLyricsPosition() {
  return getDefaultLyricsPosition();
}

function saveLyricsPosition(x, y) {
  try {
    fs.writeFileSync(LYRICS_POS_FILE, JSON.stringify({ x, y, updatedAt: new Date().toISOString() }, null, 2));
    console.log(`[Lyrics Window] Position saved: x=${x}, y=${y}`);
  } catch (err) {}
}

// Create Floating Transparent Lyrics Window
function createLyricsWindow() {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.show();
    return lyricsWindow;
  }

  userCustomCenterX = null;
  // Always initialize at the exact Bottom-Center default position on launch
  const defaultPos = getDefaultLyricsPosition(240, 32);

  const windowOpts = {
    width: 240,
    height: 32,
    x: defaultPos.x,
    y: defaultPos.y,
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
  };

  lyricsWindow = new BrowserWindow(windowOpts);

  // Load the lyrics page
  lyricsWindow.loadURL('http://127.0.0.1:3000/lyrics.html');

  // Auto-show on launch once ready
  lyricsWindow.once('ready-to-show', () => {
    lyricsWindow.setPosition(defaultPos.x, defaultPos.y);
    lyricsWindow.show();
    lyricsWindow.webContents.send('toggle-lyrics-bg', lyricsBgEnabled);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lyrics-visibility-changed', true);
    }
    saveLyricsPosition(defaultPos.x, defaultPos.y);
  });

  // Automatically remember position whenever moved/dragged on screen
  let moveTimeout = null;
  lyricsWindow.on('moved', () => {
    if (isProgrammaticResize) return;
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      const [x, y] = lyricsWindow.getPosition();
      const [w] = lyricsWindow.getSize();
      userCustomCenterX = Math.round(x + w / 2);
      saveLyricsPosition(x, y);
    }
  });

  lyricsWindow.on('move', () => {
    if (isProgrammaticResize) return;
    clearTimeout(moveTimeout);
    moveTimeout = setTimeout(() => {
      if (isProgrammaticResize) return;
      if (lyricsWindow && !lyricsWindow.isDestroyed()) {
        const [x, y] = lyricsWindow.getPosition();
        const [w] = lyricsWindow.getSize();
        userCustomCenterX = Math.round(x + w / 2);
        saveLyricsPosition(x, y);
      }
    }, 200);
  });

  lyricsWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      lyricsWindow.hide();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('lyrics-visibility-changed', false);
      }
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
  if (!lyricsWindow || lyricsWindow.isDestroyed()) {
    console.log('[Lyrics Window] Creating window from toggleLyricsWindow');
    createLyricsWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lyrics-visibility-changed', true);
    }
    return;
  }
  const isVis = lyricsWindow.isVisible();
  console.log(`[Lyrics Window] Current visibility: ${isVis}, toggling to: ${!isVis}`);
  if (isVis) {
    lyricsWindow.hide();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lyrics-visibility-changed', false);
    }
  } else {
    lyricsWindow.show();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('lyrics-visibility-changed', true);
    }
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

// IPC Listener to dynamically resize lyricsWindow to fit exact text dimensions while keeping horizontal center locked
ipcMain.on('resize-lyrics-window', (event, { width, height }) => {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    try {
      const workArea = getWorkArea();
      const maxW = Math.max(300, workArea.width - 40);
      const w = Math.min(maxW, Math.max(60, Math.ceil(width)));
      const h = Math.max(18, Math.ceil(height));
      const screenCenterX = Math.round(workArea.x + workArea.width / 2);
      const targetCenter = userCustomCenterX !== null ? userCustomCenterX : screenCenterX;
      let newX = Math.round(targetCenter - w / 2);

      // Clamp horizontally so window remains fully inside work area
      if (newX < workArea.x + 10) newX = workArea.x + 10;
      if (newX + w > workArea.x + workArea.width - 10) newX = workArea.x + workArea.width - 10 - w;

      const [, currentY] = lyricsWindow.getPosition();
      isProgrammaticResize = true;
      lyricsWindow.setBounds({ x: newX, y: currentY, width: w, height: h });
      setTimeout(() => { isProgrammaticResize = false; }, 80);
    } catch (e) {
      lyricsWindow.setSize(Math.ceil(width), Math.ceil(height), false);
    }
  }
});

// IPC Listener to toggle floating lyrics window directly
ipcMain.on('toggle-lyrics', () => {
  toggleLyricsWindow();
});

// Lyrics Background State (Default: OFF / transparent on launch)
let lyricsBgEnabled = false;

function toggleLyricsBackground(forceState) {
  if (typeof forceState === 'boolean') {
    lyricsBgEnabled = forceState;
  } else {
    lyricsBgEnabled = !lyricsBgEnabled;
  }
  if (lyricsWindow && !lyricsWindow.isDestroyed()) {
    lyricsWindow.webContents.send('toggle-lyrics-bg', lyricsBgEnabled);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('lyrics-bg-changed', lyricsBgEnabled);
  }
  console.log(`[Lyrics Window] Background is now: ${lyricsBgEnabled ? 'ON' : 'OFF'}`);
  if (lyricsBgEnabled) {
    if (currentAdaptiveTheme !== 'dark') {
      currentAdaptiveTheme = 'dark';
      if (lyricsWindow && !lyricsWindow.isDestroyed()) {
        lyricsWindow.webContents.send('set-adaptive-theme', 'dark');
      }
    }
  } else {
    checkScreenLuminance();
  }
}

ipcMain.on('toggle-lyrics-bg', (event, state) => {
  toggleLyricsBackground(state);
});

ipcMain.handle('get-lyrics-bg-state', () => {
  return lyricsBgEnabled;
});

// --- Adaptive Screen Color Contrast Sampler ---
const SAMPLER_EXE = path.join(__dirname, 'tools', 'screen_sampler.exe');
let samplerProcess = null;
let currentAdaptiveTheme = 'dark';
let adaptiveSamplingInterval = null;

function ensureSamplerCompiled() {
  if (fs.existsSync(SAMPLER_EXE)) return true;
  const csFile = path.join(__dirname, 'tools', 'screen_sampler.cs');
  if (!fs.existsSync(csFile)) return false;
  const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  if (!fs.existsSync(cscPath)) return false;
  try {
    const { execFileSync } = require('child_process');
    execFileSync(cscPath, ['/nologo', '/optimize+', `/out:${SAMPLER_EXE}`, csFile]);
    return fs.existsSync(SAMPLER_EXE);
  } catch (err) {
    console.error('[Adaptive Theme] Compilation error:', err);
    return false;
  }
}

function startSamplerProcess() {
  if (samplerProcess) return;
  if (!ensureSamplerCompiled()) {
    console.warn('[Adaptive Theme] Screen sampler executable not available.');
    return;
  }

  try {
    samplerProcess = spawn(SAMPLER_EXE, [], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    });

    samplerProcess.stdout.on('data', (data) => {
      const output = data.toString().trim();
      const lines = output.split('\n');
      const latestTheme = lines[lines.length - 1].trim();
      if (latestTheme === 'light' || latestTheme === 'dark') {
        if (currentAdaptiveTheme !== latestTheme) {
          currentAdaptiveTheme = latestTheme;
          if (lyricsWindow && !lyricsWindow.isDestroyed()) {
            lyricsWindow.webContents.send('set-adaptive-theme', currentAdaptiveTheme);
          }
        }
      }
    });

    samplerProcess.on('exit', () => {
      samplerProcess = null;
    });
  } catch (err) {
    console.error('[Adaptive Theme] Failed to start sampler process:', err);
  }
}

function stopSamplerProcess() {
  if (adaptiveSamplingInterval) {
    clearInterval(adaptiveSamplingInterval);
    adaptiveSamplingInterval = null;
  }
  if (samplerProcess) {
    try {
      samplerProcess.stdin.write('exit\n');
      samplerProcess.kill();
    } catch (e) {}
    samplerProcess = null;
  }
}

function checkScreenLuminance() {
  if (!lyricsWindow || lyricsWindow.isDestroyed() || !lyricsWindow.isVisible()) {
    return;
  }
  // If background box is enabled (dark glass), force dark theme (white text) and skip sampling
  if (lyricsBgEnabled) {
    if (currentAdaptiveTheme !== 'dark') {
      currentAdaptiveTheme = 'dark';
      lyricsWindow.webContents.send('set-adaptive-theme', 'dark');
    }
    return;
  }

  if (!samplerProcess) {
    startSamplerProcess();
    if (!samplerProcess) return;
  }

  try {
    const [x, y] = lyricsWindow.getPosition();
    const [w, h] = lyricsWindow.getSize();
    samplerProcess.stdin.write(`${x} ${y} ${w} ${h}\n`);
  } catch (err) {}
}

function startAdaptiveSampling() {
  startSamplerProcess();
  if (!adaptiveSamplingInterval) {
    adaptiveSamplingInterval = setInterval(checkScreenLuminance, 700);
  }
}

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

/**
 * =========================================================================================
 * 🧠 CORE INTELLIGENCE: Synced Lyrics Matcher & Anti-Desync Scoring Engine
 * =========================================================================================
 * ฟังก์ชันนี้คือหัวใจสำคัญในการเลือกไฟล์เนื้อเพลงที่ "ตรงจังหวะและตรงเวอร์ชัน 100%":
 * 
 * 1. Duration Matching (ตรวจจับความยาวเพลงระดับมิลลิวินาทีจาก Spotify):
 *    - ป้องกันปัญหาเนื้อเพลงไม่ตรงจังหวะ (Desync) โดยให้คะแนนโบนัสสูงสุด (+60) 
 *      กับไฟล์เนื้อเพลงที่ความยาวตรงกับเพลงบน Spotify (±3s)
 * 
 * 2. MV & Video Filter (ระบบกรองเพลงเวอร์ชัน Music Video):
 *    - ตัดคะแนน (-40) ไฟล์ที่เป็นเวอร์ชัน MV/YouTube ที่มักมีบทสนทนาหรืออินโทรเกินมา 
 *      (แก้ปัญหาดีเลย์ 10-15 วินาที เช่น เพลง Reminder ของ The Weeknd)
 * 
 * 3. Special Version Handler (ตรวจจับ Edit, Remix, Acoustic, Live):
 *    - จับคู่อัตโนมัติสำหรับเวอร์ชันตัดต่อพิเศษ เช่น 'Happier Than Ever - Edit'
 *      ให้ดึงเนื้อเพลงของท่อนตัดต่อโดยเฉพาะ ไม่ดึงเวอร์ชันเต็มมาปน
 * 
 * 4. Fuzzy Artist & Title Verification:
 *    - ตัดอักขระพิเศษ เว้นวรรค และวงเล็บ เพื่อเทียบความถูกต้องแม้ชื่อเพลงจะมีฟอร์แมตต่างกัน
 * =========================================================================================
 */
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

    // Artist verification (+50 if artist matches, -40 penalty if artist mismatches)
    if (artistNorm && (singerList.includes(artistNorm) || artistNorm.includes(singerList))) {
      score += 50;
    } else {
      score -= 40;
    }

    // Reward if both target and song are Remix/Edit, penalty if mismatches
    if (isTargetRemix && isSongRemix) score += 30;
    if (!isTargetRemix && isSongRemix) score -= 30;

    // Penalty for Music Video versions if target is not MV (MVs often have intro/outro delays)
    if (!targetNorm.includes('video') && !targetNorm.includes('mv') && (songNorm.includes('officialvideo') || songNorm.includes('musicvideo') || songNorm.includes('video') || songNorm.includes('mv'))) {
      score -= 40;
    }

    // Duration matching bonus & penalty (Ensures exact audio sync with Spotify track)
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
  // Require high confidence score (score >= 50)
  return bestScore >= 50 ? bestSong : null;
}

// Native Node.js Lyrics Engine (LRCLIB + QQ Music) for 100% Thai & International Coverage
async function getSyncedLyricsBackend(trackName, artistName, targetDurationSec = null) {
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


// IPC Handle for Lyrics Fetching directly from Electron Main Node Process
ipcMain.handle('get-lyrics', async (event, { track, artist, duration }) => {
  if (!track || !artist) return null;
  return await getSyncedLyricsBackend(track, artist, duration);
});

// IPC Handle for Real-time Line Translation
ipcMain.handle('get-translation', async (event, text) => {
  return await translateTextBackend(text);
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
      { label: '🖼️ Toggle Lyrics Background (Alt+B)', click: () => toggleLyricsBackground() },
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
    startAdaptiveSampling();
  }, 1000);

  // Register Global Hotkeys
  try {
    globalShortcut.register('Alt+Shift+S', () => {
      toggleWindow();
    });

    globalShortcut.register('Alt+Space', () => {
      toggleWindow();
    });

    // Register Hotkeys for Lyrics Toggle
    const toggleLyrics = (keyName) => {
      console.log(`[Lyrics Hotkey] Triggered via ${keyName} at ${new Date().toLocaleTimeString()}`);
      toggleLyricsWindow();
    };

    const shortcuts = [
      'Alt+\\',
      'Alt+K',
      'Alt+L',
      'Alt+Shift+L',
      'Ctrl+Shift+L',
      'Alt+F9',
      'Alt+`'
    ];
    shortcuts.forEach(sc => {
      try {
        const ok = globalShortcut.register(sc, () => toggleLyrics(sc));
        console.log(`Shortcut [${sc}] registered:`, ok);
      } catch (err) {
        console.error(`Shortcut [${sc}] registration error:`, err.message);
      }
    });

    // Register Hotkey for Lyrics Background Toggle (Alt+B)
    try {
      const bgOk = globalShortcut.register('Alt+B', () => toggleLyricsBackground());
      console.log('Shortcut [Alt+B] registered:', bgOk);
    } catch (err) {
      console.error('Shortcut [Alt+B] registration error:', err.message);
    }

    // Register Global Hotkey for Translation Toggle (Alt+T)
    try {
      const transOk = globalShortcut.register('Alt+T', () => {
        console.log('[Translation Hotkey] Triggered via Alt+T');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('toggle-translation-hotkey');
        }
      });
      console.log('Shortcut [Alt+T] registered:', transOk);
    } catch (err) {
      console.error('Shortcut [Alt+T] registration error:', err.message);
    }
  } catch (err) {
    console.error('Shortcut registration error:', err);
  }
});

app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll();
  } catch (err) {}
  stopSamplerProcess();
  if (serverProcess) serverProcess.kill();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// 999
