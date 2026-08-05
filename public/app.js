// Spotify Stealth Quick Bar Logic

const SCOPES = 'user-modify-playback-state user-read-playback-state user-read-currently-playing user-top-read playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private';

// State
let spotifyAccessToken = localStorage.getItem('spotify_access_token') || null;
let spotifyRefreshToken = localStorage.getItem('spotify_refresh_token') || null;
let spotifyClientId = localStorage.getItem('spotify_client_id') || '';
let spotifyRedirectUri = localStorage.getItem('spotify_redirect_uri') || 'http://127.0.0.1:3000/callback';
let selectedTrackIndex = -1;
let currentSearchResults = [];
let searchDebounceTimer = null;
let nowPlayingInterval = null;
let volDebounceTimer = null;
let currentVolume = 70;
let previousVolume = 70;
let isMuted = false;

// Lyrics & Sync State
let lyricsList = []; // parsed synced lyrics: [{ timeMs, text }]
let currentTrackId = '';
let currentTrackProgress = 0;
let lastProgressUpdate = 0;
let isPlaying = false;
let lyricsSyncTimer = null;
let isKaraokeActive = true; // starts as true because lyricsWindow auto-shows on launch

// DOM Elements
const searchInput = document.getElementById('searchInput');
const trackList = document.getElementById('trackList');
const emptyState = document.getElementById('emptyState');
const resultsContainer = document.getElementById('resultsContainer');
const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const deviceAlert = document.getElementById('deviceAlert');
const btnRefreshDevices = document.getElementById('btnRefreshDevices');
const btnSneakToggle = document.getElementById('btnSneakToggle');
const sneakBtnLabel = document.getElementById('sneakBtnLabel');
const btnMinimizeWindow = document.getElementById('btnMinimizeWindow');
const btnCloseAppWindow = document.getElementById('btnCloseAppWindow');
const btnSettingsModal = document.getElementById('btnSettingsModal');
const settingsModal = document.getElementById('settingsModal');
const clientIdInput = document.getElementById('clientIdInput');
const redirectUriInput = document.getElementById('redirectUriInput');
const displayRedirectUri = document.getElementById('displayRedirectUri');
const btnSaveSettings = document.getElementById('btnSaveSettings');
const btnCancelSettings = document.getElementById('btnCancelSettings');
const btnCloseSettings = document.getElementById('btnCloseSettings');
const appTitle = document.getElementById('appTitle');

// Karaoke / Lyrics DOM
const btnKaraokeToggle = document.getElementById('btnKaraokeToggle');
const lyricsContainer = document.getElementById('lyricsContainer');
const lyricsScrollBox = document.getElementById('lyricsScrollBox');
const lyricsPlaceholder = document.getElementById('lyricsPlaceholder');

// Toast Elements
const toastBanner = document.getElementById('toastBanner');
const toastIcon = document.getElementById('toastIcon');
const toastMessage = document.getElementById('toastMessage');

// Mini Player Elements
const miniPlayer = document.getElementById('miniPlayer');
const playerAlbumArt = document.getElementById('playerAlbumArt');
const playerTitle = document.getElementById('playerTitle');
const playerArtist = document.getElementById('playerArtist');
const btnPlayPause = document.getElementById('btnPlayPause');
const playIconSvg = document.getElementById('playIconSvg');
const btnPrev = document.getElementById('btnPrev');
const btnNext = document.getElementById('btnNext');
const volSlider = document.getElementById('volSlider');
const volPercent = document.getElementById('volPercent');
const btnMuteToggle = document.getElementById('btnMuteToggle');
const volIconSvg = document.getElementById('volIconSvg');

// Electron IPC Helper
function notifyWindowResize(height) {
  try {
    if (window.require) {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.send('resize-window', height);
    }
  } catch (err) {}
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Sync Session from Server
  await syncSessionFromServer();

  // Save default client ID & redirect URI into localStorage
  localStorage.setItem('spotify_client_id', spotifyClientId);
  localStorage.setItem('spotify_redirect_uri', spotifyRedirectUri);

  // Update UI inputs
  clientIdInput.value = spotifyClientId;
  redirectUriInput.value = spotifyRedirectUri;
  if (displayRedirectUri) displayRedirectUri.textContent = spotifyRedirectUri;

  // Set default initial collapsed state & height
  resultsContainer.classList.add('collapsed');
  lyricsContainer.classList.add('collapsed');
  notifyWindowResize(210);

  // Handle OAuth Callback
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  if (code) {
    await handleOAuthCallback(code);
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  // Setup Event Listeners
  setupEventListeners();

  // Check Token & Connection
  if (spotifyAccessToken) {
    updateConnectionStatus(true, 'CONNECTED');
    await refreshActiveDevices();
    startNowPlayingPolling();
    startLocalLyricsClock();
  } else {
    updateConnectionStatus(false, 'DISCONNECTED');
  }
});

async function syncSessionFromServer() {
  try {
    const res = await fetch('/api/get-session');
    const data = await res.json();
    if (data.spotify_access_token) {
      spotifyAccessToken = data.spotify_access_token;
      spotifyRefreshToken = data.spotify_refresh_token || spotifyRefreshToken;
      spotifyClientId = data.spotify_client_id || spotifyClientId;
      spotifyRedirectUri = data.spotify_redirect_uri || spotifyRedirectUri;

      localStorage.setItem('spotify_access_token', spotifyAccessToken);
      if (spotifyRefreshToken) localStorage.setItem('spotify_refresh_token', spotifyRefreshToken);
      localStorage.setItem('spotify_client_id', spotifyClientId);
      localStorage.setItem('spotify_redirect_uri', spotifyRedirectUri);
    }
  } catch (err) {}
}

async function saveSessionToServer() {
  try {
    await fetch('/api/save-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spotify_access_token: spotifyAccessToken,
        spotify_refresh_token: spotifyRefreshToken,
        spotify_client_id: spotifyClientId,
        spotify_redirect_uri: spotifyRedirectUri
      })
    });
  } catch (err) {}
}

// Force Reconnect & Player Sync
async function forceSyncAndReconnect() {
  const syncBtnIcon = document.getElementById('syncBtnIcon');
  if (syncBtnIcon) syncBtnIcon.classList.add('spinning');
  showToastNotification('🔄', 'Syncing with Spotify...');

  try {
    // 1. Force Refresh Token
    if (spotifyRefreshToken) {
      await refreshAccessToken();
    }

    // 2. Reset Null Poll Counter & Fetch Currently Playing
    consecutiveNullPolls = 0;
    currentTrackId = null; // force lyrics reload
    await fetchCurrentlyPlaying();

    updateConnectionStatus(true, 'CONNECTED');
    showToastNotification('✅', 'Synced with Spotify!');
  } catch (err) {
    console.error('Force Sync Error:', err);
    showToastNotification('⚠️', 'Sync Failed');
  } finally {
    if (syncBtnIcon) syncBtnIcon.classList.remove('spinning');
  }
}

function setupEventListeners() {
  // Search Input
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchDebounceTimer);
    const query = e.target.value.trim();
    if (!query) {
      currentSearchResults = [];
      renderSearchResults([]);
      return;
    }
    searchDebounceTimer = setTimeout(() => performSearch(query), 250);
  });

  // Keyboard Shortcuts
  document.addEventListener('keydown', handleGlobalKeydown);

  // Buttons
  const btnForceReconnect = document.getElementById('btnForceReconnect');
  if (btnForceReconnect) btnForceReconnect.addEventListener('click', forceSyncAndReconnect);
  if (statusBadge) statusBadge.addEventListener('click', forceSyncAndReconnect);
  if (btnSettingsModal) btnSettingsModal.addEventListener('click', showSettingsModal);
  btnCancelSettings.addEventListener('click', hideSettingsModal);
  btnCloseSettings.addEventListener('click', hideSettingsModal);
  btnSaveSettings.addEventListener('click', saveSettings);
  btnRefreshDevices.addEventListener('click', refreshActiveDevices);
  btnSneakToggle.addEventListener('click', toggleSneakMode);
  
  // Karaoke Toggle
  if (btnKaraokeToggle) {
    btnKaraokeToggle.addEventListener('click', toggleKaraoke);
  }

  // Minimize (Hide to Tray)
  if (btnMinimizeWindow) {
    btnMinimizeWindow.addEventListener('click', () => {
      window.close();
    });
  }

  // Close (Exit App)
  if (btnCloseAppWindow) {
    btnCloseAppWindow.addEventListener('click', () => {
      fetch('/api/clear-session').catch(() => {});
      window.close();
    });
  }

  // Volume Slider Dragging
  if (volSlider) {
    volSlider.addEventListener('input', (e) => {
      setVolume(parseInt(e.target.value, 10));
    });
  }

  // Mute / Unmute Button
  if (btnMuteToggle) {
    btnMuteToggle.addEventListener('click', toggleMute);
  }

  // Mouse Wheel Volume Scroll on Footer
  if (miniPlayer) {
    miniPlayer.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 5 : -5;
      setVolume(currentVolume + delta);
    }, { passive: false });
  }

  // Player controls
  btnPlayPause.addEventListener('click', togglePlayPause);
  btnPrev.addEventListener('click', () => spotifyApiCall('/v1/me/player/previous', 'POST'));
  btnNext.addEventListener('click', () => spotifyApiCall('/v1/me/player/next', 'POST'));
}

// Global Keydown Handler
function handleGlobalKeydown(e) {
  // Alt+S -> Focus Search Input
  if (e.altKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }

  // Alt+M -> Toggle Sneak Mode
  if (e.altKey && (e.key === 'm' || e.key === 'M')) {
    e.preventDefault();
    toggleSneakMode();
    return;
  }

  // Alt+K -> Toggle Karaoke Lyrics
  if (e.altKey && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    toggleKaraoke();
    return;
  }

  // Alt+Up -> Volume Up (+10%)
  if (e.altKey && e.key === 'ArrowUp') {
    e.preventDefault();
    setVolume(currentVolume + 10);
    showToastNotification('🔊', `Volume: ${currentVolume}%`);
    return;
  }

  // Alt+Down -> Volume Down (-10%)
  if (e.altKey && e.key === 'ArrowDown') {
    e.preventDefault();
    setVolume(currentVolume - 10);
    showToastNotification('🔉', `Volume: ${currentVolume}%`);
    return;
  }

  // Alt+0 -> Toggle Mute
  if (e.altKey && e.key === '0') {
    e.preventDefault();
    toggleMute();
    return;
  }

  // Esc -> Clear search/lyrics or blur
  if (e.key === 'Escape') {
    if (document.activeElement === searchInput && searchInput.value) {
      searchInput.value = '';
      currentSearchResults = [];
      renderSearchResults([]);
    } else {
      window.close();
    }
    return;
  }

  // Navigation when search input is focused or active
  if (currentSearchResults.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedTrackIndex = Math.min(selectedTrackIndex + 1, currentSearchResults.length - 1);
      highlightSelectedTrack();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedTrackIndex = Math.max(selectedTrackIndex - 1, 0);
      highlightSelectedTrack();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedTrackIndex >= 0 && selectedTrackIndex < currentSearchResults.length) {
        const item = currentSearchResults[selectedTrackIndex];
        if (item.type === 'track') {
          if (e.shiftKey) {
            addToQueue(item.uri, item.name);
          } else {
            playMediaContext(item.uri, item.name, 'track');
          }
        } else {
          playMediaContext(item.uri, item.name, item.type);
        }
      }
    }
  }
}

// Volume Control Logic
function setVolume(newVol) {
  currentVolume = Math.min(Math.max(newVol, 0), 100);
  if (volSlider) volSlider.value = currentVolume;
  if (volPercent) volPercent.textContent = `${currentVolume}%`;

  if (currentVolume > 0) {
    isMuted = false;
    updateVolIcon(false);
  } else {
    isMuted = true;
    updateVolIcon(true);
  }

  clearTimeout(volDebounceTimer);
  volDebounceTimer = setTimeout(() => {
    spotifyApiCall(`/v1/me/player/volume?volume_percent=${currentVolume}`, 'PUT');
  }, 200);
}

function toggleMute() {
  if (isMuted) {
    setVolume(previousVolume || 50);
    showToastNotification('🔊', `Unmuted: ${currentVolume}%`);
  } else {
    previousVolume = currentVolume;
    setVolume(0);
    showToastNotification('🔇', 'Muted');
  }
}

function updateVolIcon(muted) {
  if (!volIconSvg) return;
  if (muted) {
    volIconSvg.innerHTML = '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73 4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>';
  } else {
    volIconSvg.innerHTML = '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
  }
}

// Sneak Mode Toggle
function toggleSneakMode() {
  document.body.classList.toggle('sneak-mode');
  const isSneak = document.body.classList.contains('sneak-mode');
  if (appTitle) appTitle.textContent = isSneak ? 'SysMon v2.4' : 'Spotify Command';
  if (sneakBtnLabel) sneakBtnLabel.textContent = isSneak ? 'Normal' : 'Sneak';
  if (window.require) {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.send('sync-sneak-mode', isSneak);
  }
}

// Karaoke Toggle
function toggleKaraoke() {
  isKaraokeActive = !isKaraokeActive;
  if (isKaraokeActive) {
    btnKaraokeToggle.classList.add('active');
  } else {
    btnKaraokeToggle.classList.remove('active');
  }
  if (window.require) {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.send('toggle-lyrics-view');
  }
}

// PKCE Helper Functions
function generateRandomString(length) {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let text = '';
  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

async function generateCodeChallenge(codeVerifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await window.crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode.apply(null, new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Login
async function startSpotifyLogin() {
  if (!spotifyClientId) {
    alert('Please enter your Spotify Client ID first in Settings (⚙️)!');
    showSettingsModal();
    return;
  }

  const verifier = generateRandomString(128);
  localStorage.setItem('pkce_verifier', verifier);
  await saveSessionToServer();
  const challenge = await generateCodeChallenge(verifier);

  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.search = new URLSearchParams({
    client_id: spotifyClientId,
    response_type: 'code',
    redirect_uri: spotifyRedirectUri,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    show_dialog: 'true'
  }).toString();

  if (window.navigator.userAgent.includes('Electron')) {
    window.open(authUrl.toString(), '_blank');
  } else {
    window.location.href = authUrl.toString();
  }
}

async function handleOAuthCallback(code) {
  const verifier = localStorage.getItem('pkce_verifier');
  if (!verifier) return;

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: spotifyClientId,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: spotifyRedirectUri,
        code_verifier: verifier
      })
    });

    const data = await response.json();
    if (data.access_token) {
      spotifyAccessToken = data.access_token;
      spotifyRefreshToken = data.refresh_token || null;
      localStorage.setItem('spotify_access_token', spotifyAccessToken);
      if (spotifyRefreshToken) localStorage.setItem('spotify_refresh_token', spotifyRefreshToken);
      
      await saveSessionToServer();
      updateConnectionStatus(true, 'CONNECTED');
    }
  } catch (err) {
    console.error('OAuth Callback Error:', err);
  }
}

// Refresh Token
async function refreshAccessToken() {
  if (!spotifyRefreshToken || !spotifyClientId) return false;
  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: spotifyClientId,
        grant_type: 'refresh_token',
        refresh_token: spotifyRefreshToken
      })
    });

    const data = await response.json();
    if (data.access_token) {
      spotifyAccessToken = data.access_token;
      localStorage.setItem('spotify_access_token', spotifyAccessToken);
      await saveSessionToServer();
      return true;
    }
  } catch (err) {
    console.error('Token Refresh Failed:', err);
  }
  return false;
}

// Generic Spotify API Wrapper
async function spotifyApiCall(endpoint, method = 'GET', body = null) {
  if (!spotifyAccessToken) {
    updateConnectionStatus(false, 'DISCONNECTED');
    return null;
  }

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${spotifyAccessToken}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) options.body = JSON.stringify(body);

  let res = await fetch(`https://api.spotify.com${endpoint}`, options);

  // Handle Token Expiry
  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      options.headers['Authorization'] = `Bearer ${spotifyAccessToken}`;
      res = await fetch(`https://api.spotify.com${endpoint}`, options);
    } else {
      updateConnectionStatus(false, 'EXPIRED');
      return null;
    }
  }

  // Handle 429 Rate Limit gracefully without breaking playback state
  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
    console.warn(`Spotify 429 Rate Limited. Pausing polling for ${retryAfter}s`);
    showToastNotification('⚠️', `Spotify Rate Limit. Change Client ID in Settings ⚙️ if stuck.`);
    return { isRateLimited: true, retryAfter };
  }

  if (res.status === 204) return true;
  return res.ok ? await res.json() : null;
}

// Perform Multi-Category Search (Tracks, Artists, Playlists)
async function performSearch(query) {
  const data = await spotifyApiCall(`/v1/search?q=${encodeURIComponent(query)}&type=track,artist,playlist&limit=4`);
  if (data) {
    const tracks = (data.tracks?.items || []).map(t => ({ ...t, type: 'track' }));
    const artists = (data.artists?.items || []).map(a => ({ ...a, type: 'artist' }));
    const playlists = (data.playlists?.items || []).map(p => ({ ...p, type: 'playlist' }));

    // Combined search results list
    currentSearchResults = [...tracks, ...artists, ...playlists];
    selectedTrackIndex = currentSearchResults.length > 0 ? 0 : -1;
    renderSearchResults(currentSearchResults);
  }
}

// Render Search Results with Badges
function renderSearchResults(items) {
  trackList.innerHTML = '';
  if (items.length === 0) {
    resultsContainer.classList.add('collapsed');
    if (!isKaraokeActive) notifyWindowResize(210);
    return;
  }
  
  // Close lyrics panel when displaying search results to prevent overlay overlap
  if (isKaraokeActive) toggleKaraoke();
  
  resultsContainer.classList.remove('collapsed');
  notifyWindowResize(460);

  items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = `track-item ${index === selectedTrackIndex ? 'selected' : ''}`;
    row.dataset.index = index;

    let artUrl = '';
    let titleText = item.name;
    let subtitleText = '';
    let badgeText = 'TRACK';
    let isArtist = item.type === 'artist';

    if (item.type === 'track') {
      artUrl = item.album.images[2]?.url || item.album.images[0]?.url || '';
      subtitleText = item.artists.map(a => a.name).join(', ');
      badgeText = '🎵 Song';
    } else if (item.type === 'artist') {
      artUrl = item.images[2]?.url || item.images[0]?.url || '';
      subtitleText = `Artist • ${item.followers?.total ? item.followers.total.toLocaleString() + ' followers' : 'Artist'}`;
      badgeText = '👤 Artist';
    } else if (item.type === 'playlist') {
      artUrl = item.images[0]?.url || '';
      subtitleText = `Playlist • ${item.owner?.display_name ? 'By ' + item.owner.display_name : 'Playlist'}`;
      badgeText = '📜 Playlist';
    }

    row.innerHTML = `
      <div class="track-left">
        <img class="track-art ${isArtist ? 'artist-avatar' : ''}" src="${artUrl || 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'38\' height=\'38\' viewBox=\'0 0 38 38\'%3E%3Crect width=\'38\' height=\'38\' fill=\'%23222\'/%3E%3C/svg%3E'}" alt="Art">
        <div class="track-details">
          <span class="track-name">${escapeHtml(titleText)} <span class="type-tag">${badgeText}</span></span>
          <span class="track-artist">${escapeHtml(subtitleText)}</span>
        </div>
      </div>
      <div class="track-actions">
        <button class="act-btn btn-play" title="Play Now (Enter)">▶ Play</button>
        ${item.type === 'track' ? '<button class="act-btn btn-queue" title="Add to Queue (Shift+Enter)">➕ Queue</button>' : ''}
      </div>
    `;

    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-queue') && item.type === 'track') {
        addToQueue(item.uri, item.name);
      } else {
        playMediaContext(item.uri, item.name, item.type);
      }
    });

    row.addEventListener('mouseenter', () => {
      selectedTrackIndex = index;
      highlightSelectedTrack();
    });

    trackList.appendChild(row);
  });
}

function highlightSelectedTrack() {
  const items = trackList.querySelectorAll('.track-item');
  items.forEach((item, index) => {
    if (index === selectedTrackIndex) {
      item.classList.add('selected');
      item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      item.classList.remove('selected');
    }
  });
}

// Play Media (Track, Artist, Playlist)
async function playMediaContext(uri, name, type) {
  let body = {};
  if (type === 'track') {
    body = { uris: [uri] };
  } else {
    body = { context_uri: uri };
  }

  const success = await spotifyApiCall('/v1/me/player/play', 'PUT', body);
  if (success) {
    const label = type === 'artist' ? '👤 ศิลปิน' : type === 'playlist' ? '📜 เพลย์ลิสต์' : '▶️ เพลง';
    showToastNotification('▶️', `กำลังเล่น ${label}: ${name}`);
    setTimeout(fetchCurrentlyPlaying, 500);
  } else {
    refreshActiveDevices();
  }
}

// Queue Track
async function addToQueue(trackUri, trackName) {
  const success = await spotifyApiCall(`/v1/me/player/queue?uri=${encodeURIComponent(trackUri)}`, 'POST');
  if (success) {
    showToastNotification('➕', `เพิ่มเพลงลงคิวสำเร็จ: ${trackName}`);
  } else {
    refreshActiveDevices();
  }
}

// Play / Pause Toggle
async function togglePlayPause() {
  const state = await spotifyApiCall('/v1/me/player');
  if (state) {
    const endpoint = state.is_playing ? '/v1/me/player/pause' : '/v1/me/player/play';
    await spotifyApiCall(endpoint, 'PUT');
    setTimeout(fetchCurrentlyPlaying, 300);
  }
}

// Active Devices Check
async function refreshActiveDevices() {
  const data = await spotifyApiCall('/v1/me/player/devices');
  if (data && data.devices) {
    const activeDevice = data.devices.find(d => d.is_active) || data.devices[0];
    if (activeDevice) {
      deviceAlert.classList.add('hidden');
      updateConnectionStatus(true, 'CONNECTED');
    } else {
      deviceAlert.classList.remove('hidden');
      updateConnectionStatus(true, 'OPEN SPOTIFY APP');
    }
  }
}

// Fetch synced lyrics (Direct IPC from Electron Main Process for 100% Zero-Latency & Zero-CORS Reliability)
async function fetchSyncedLyrics(trackName, artistName, trackId) {
  lyricsScrollBox.innerHTML = '<div class="lyrics-placeholder">Loading lyrics...</div>';
  lyricsList = [];
  lastActiveIndex = -1;

  // 1. Native Electron IPC handle (Direct Node Process)
  try {
    if (window.require) {
      const { ipcRenderer } = window.require('electron');
      const lyrics = await ipcRenderer.invoke('get-lyrics', { track: trackName, artist: artistName });
      if (lyrics) {
        parseLrcLines(lyrics);
        renderLyrics();
        return;
      }
    }
  } catch (err) {
    console.warn('IPC lyrics fetch failed, trying HTTP...', err);
  }

  // 2. HTTP Fallback
  try {
    const url = `/api/lyrics?track=${encodeURIComponent(trackName)}&artist=${encodeURIComponent(artistName)}`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data && data.lyrics) {
        parseLrcLines(data.lyrics);
        renderLyrics();
        return;
      }
    }
  } catch (err) {}

  showNoLyricsPlaceholder();
}

function parseLrcLines(lrcText) {
  const decoded = lrcText
    .replace(/&#58;/g, ':')
    .replace(/&#46;/g, '.')
    .replace(/&#10;/g, '\n')
    .replace(/&#32;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');

  const lines = decoded.split('\n');
  lyricsList = [];
  const timeRegex = /^\[(\d+):(\d+)(?:\.|:)(\d+)\](.*)/;

  for (let line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[ti:') || trimmed.startsWith('[ar:') || trimmed.startsWith('[al:') || trimmed.startsWith('[by:') || trimmed.startsWith('[offset:')) {
      continue;
    }
    const match = timeRegex.exec(trimmed);
    if (match) {
      const minutes = parseInt(match[1], 10);
      const seconds = parseInt(match[2], 10);
      const msStr = match[3].padEnd(3, '0').substring(0, 3);
      const ms = parseInt(msStr, 10);
      const text = match[4].trim();
      const timeMs = (minutes * 60 + seconds) * 1000 + ms;
      if (text || lyricsList.length > 0) {
        lyricsList.push({ timeMs, text });
      }
    }
  }
  lyricsList.sort((a, b) => a.timeMs - b.timeMs);
}

function parsePlainLyrics(plainText) {
  const lines = plainText.split('\n');
  lyricsList = [];
  lines.forEach((line, index) => {
    if (line.trim()) {
      lyricsList.push({ timeMs: index * 4000, text: line.trim() });
    }
  });
}

function showNoLyricsPlaceholder() {
  lyricsScrollBox.innerHTML = '<div class="lyrics-placeholder">No lyrics available for this song.</div>';
  if (window.require) {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.send('update-lyric-text', '🎵 (No lyrics available)');
  }
}

function renderLyrics() {
  lyricsScrollBox.innerHTML = '';
  if (lyricsList.length === 0) {
    showNoLyricsPlaceholder();
    return;
  }

  lyricsList.forEach((line, index) => {
    const el = document.createElement('div');
    el.className = 'lyric-line';
    el.id = `lyric-line-${index}`;
    el.textContent = line.text || '🎵';
    lyricsScrollBox.appendChild(el);
  });
}

// Lead-time offset for karaoke anticipation (450ms pre-roll so text appears right before singer sings)
const KARAOKE_LEAD_OFFSET = 450;
let currentDisplayedLyric = '';

// Real-Time Local Millisecond Lyrics Clock loop
function startLocalLyricsClock() {
  if (lyricsSyncTimer) clearInterval(lyricsSyncTimer);
  lyricsSyncTimer = setInterval(() => {
    if (!isPlaying || lyricsList.length === 0) return;

    // Calculate actual elapsed time locally + 450ms lead-in anticipation
    const elapsed = Date.now() - lastProgressUpdate;
    const currentMs = currentTrackProgress + elapsed + KARAOKE_LEAD_OFFSET;

    // Find active line
    let activeIndex = -1;
    for (let i = 0; i < lyricsList.length; i++) {
      if (lyricsList[i].timeMs <= currentMs) {
        activeIndex = i;
      } else {
        break;
      }
    }

    if (activeIndex !== -1) {
      const currentLine = lyricsList[activeIndex];
      const nextLine = lyricsList[activeIndex + 1];
      const lineTime = currentLine.timeMs;
      const nextLineTime = nextLine ? nextLine.timeMs : (lineTime + 6000);
      const gap = nextLineTime - lineTime;
      const age = currentMs - lineTime;

      // Clear old lingering line after 4.2s or 80% of gap duration
      if (age > 4200 && age > (gap * 0.8)) {
        updateOverlayLyricText('♪ ... ♪');
      } else {
        updateActiveLyricLine(activeIndex);
      }
    }
  }, 100);
}

let lastActiveIndex = -1;
function updateActiveLyricLine(activeIndex) {
  const lines = lyricsScrollBox.querySelectorAll('.lyric-line');
  lines.forEach((el, index) => {
    if (index === activeIndex) {
      if (!el.classList.contains('active')) {
        el.classList.add('active');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } else {
      el.classList.remove('active');
    }
  });

  if (activeIndex !== lastActiveIndex) {
    lastActiveIndex = activeIndex;
    let activeText = lyricsList[activeIndex]?.text || '';
    if (!activeText.trim()) {
      activeText = '♪ ... ♪';
    }
    updateOverlayLyricText(activeText);
  }
}

function updateOverlayLyricText(text) {
  if (currentDisplayedLyric !== text) {
    currentDisplayedLyric = text;
    if (window.require) {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.send('update-lyric-text', text);
    }
  }
}

// Currently Playing Polling — every 4.0s to stay safely within Spotify Web API rate limits
function startNowPlayingPolling() {
  fetchCurrentlyPlaying();
  if (nowPlayingInterval) clearInterval(nowPlayingInterval);
  nowPlayingInterval = setInterval(fetchCurrentlyPlaying, 4000);
}

let consecutiveNullPolls = 0;

async function fetchCurrentlyPlaying() {
  const data = await spotifyApiCall('/v1/me/player/currently-playing');
  if (data && data.isRateLimited) {
    return; // Retain current playback state during Spotify 429 rate limit window
  }
  if (data && data.item) {
    consecutiveNullPolls = 0;
    playerTitle.textContent = data.item.name;
    playerArtist.textContent = data.item.artists.map(a => a.name).join(', ');
    
    // Sync progress local variables
    currentTrackProgress = data.progress_ms || 0;
    lastProgressUpdate = Date.now();
    isPlaying = data.is_playing;

    const art = data.item.album.images[2]?.url || data.item.album.images[0]?.url;
    if (art) playerAlbumArt.src = art;

    // Fetch lyrics dynamically ONLY when track ID actually changes
    if (data.item.id !== currentTrackId) {
      currentTrackId = data.item.id;
      fetchSyncedLyrics(data.item.name, data.item.artists[0].name, data.item.id);
    }

    // Play/Pause SVG update
    if (data.is_playing) {
      playIconSvg.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
    } else {
      playIconSvg.innerHTML = '<path d="M8 5v14l11-7z"/>';
    }
  } else {
    consecutiveNullPolls++;
    // Require 8 consecutive null polls (~20 seconds) of no playback before declaring idle
    if (consecutiveNullPolls >= 8) {
      playerTitle.textContent = 'Not Playing';
      playerArtist.textContent = 'Spotify Idle';
      playIconSvg.innerHTML = '<path d="M8 5v14l11-7z"/>';
      isPlaying = false;
      currentTrackId = '';
      lyricsList = [];
      lyricsScrollBox.innerHTML = '<div class="lyrics-placeholder">Waiting for music to play...</div>';
      if (window.require) {
        const { ipcRenderer } = window.require('electron');
        ipcRenderer.send('update-lyric-text', 'Waiting for music...');
      }
    }
  }
}

// Connection Badge
function updateConnectionStatus(isConnected, text) {
  if (isConnected) {
    statusBadge.classList.add('connected');
  } else {
    statusBadge.classList.remove('connected');
  }
  statusText.textContent = text;
}

// Settings Modal
function showSettingsModal() { settingsModal.classList.remove('hidden'); }
function hideSettingsModal() { settingsModal.classList.add('hidden'); }

function saveSettings() {
  const cVal = clientIdInput.value.trim();
  const rVal = redirectUriInput.value.trim();
  if (!cVal) {
    alert('Please enter a valid Client ID!');
    return;
  }
  spotifyClientId = cVal;
  spotifyRedirectUri = rVal || 'http://127.0.0.1:3000/callback';
  localStorage.setItem('spotify_client_id', spotifyClientId);
  localStorage.setItem('spotify_redirect_uri', spotifyRedirectUri);
  hideSettingsModal();
  startSpotifyLogin();
}

// Toast Notifications
let toastTimeout = null;
function showToastNotification(icon, msg) {
  if (!toastBanner) return;
  toastIcon.textContent = icon;
  toastMessage.textContent = msg;
  toastBanner.classList.remove('hidden');

  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toastBanner.classList.add('hidden');
  }, 2500);
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
