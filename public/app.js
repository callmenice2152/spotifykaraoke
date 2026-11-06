// Spotify Stealth Quick Bar Logic - Fusion Hybrid Edition (Image 1 Idle + Image 2 Active)

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

// Lyrics & Playback Timing State
let lyricsList = []; // parsed synced lyrics: [{ timeMs, text }]
let currentTrackId = '';
let currentTrackProgress = 0;
let currentTrackDuration = 0;
let lastProgressUpdate = 0;
let isPlaying = false;
let lyricsSyncTimer = null;
let isKaraokeActive = true;
let lyricsBgEnabled = false;

// UI Interaction State
let isPinnedActive = localStorage.getItem('spotify_pinned_active') !== 'false'; // Defaults to TRUE so user sees the big screen
let isWidgetHovered = false;
let isMenuOpen = false;
let isSearchOpen = false;
let collapseTimer = null;

// DOM Elements: Core Shell & Widgets
const stealthApp = document.getElementById('stealthApp');
const stealthWidget = document.getElementById('stealthWidget');
const idleBar = document.getElementById('idleBar');
const activeCard = document.getElementById('activeCard');
const idleSubtitle = document.getElementById('idleSubtitle');
const idleTitle = document.getElementById('idleTitle');
const idleStatus = document.getElementById('idleStatus');
const idleWaveIcon = document.getElementById('idleWaveIcon');

// Overflow Menu Elements
const btnOverflowMenu = document.getElementById('btnOverflowMenu');
const overflowMenu = document.getElementById('overflowMenu');
const btnSearchTrigger = document.getElementById('btnSearchTrigger');
const lyricsTogglePill = document.getElementById('lyricsTogglePill');
const translateTogglePill = document.getElementById('translateTogglePill');
const lyricsBgTogglePill = document.getElementById('lyricsBgTogglePill');

// Spotlight Search Elements
const searchPalette = document.getElementById('searchPalette');
const searchInput = document.getElementById('searchInput');
const btnCloseSearch = document.getElementById('btnCloseSearch');
const trackList = document.getElementById('trackList');
const emptyState = document.getElementById('emptyState');
const resultsContainer = document.getElementById('resultsContainer');
const deviceAlert = document.getElementById('deviceAlert');
const btnRefreshDevices = document.getElementById('btnRefreshDevices');

// Active Player Elements (Image 2)
const playerAlbumArt = document.getElementById('playerAlbumArt');
const playerTitle = document.getElementById('playerTitle');
const playerArtist = document.getElementById('playerArtist');
const progressSection = document.getElementById('progressSection');
const progressTrack = document.getElementById('progressTrack');
const progressFill = document.getElementById('progressFill');
const btnPlayPause = document.getElementById('btnPlayPause');
const playIconSvg = document.getElementById('playIconSvg');
const btnPrev = document.getElementById('btnPrev');
const btnNext = document.getElementById('btnNext');

// Volume Controls
const volSlider = document.getElementById('volSlider');
const volPercent = document.getElementById('volPercent');
const btnMuteToggle = document.getElementById('btnMuteToggle');
const volIconSvg = document.getElementById('volIconSvg');

// Header Status & Actions
const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const btnForceReconnect = document.getElementById('btnForceReconnect');
const syncBtnIcon = document.getElementById('syncBtnIcon');
const btnSneakToggle = document.getElementById('btnSneakToggle');
const sneakBtnLabel = document.getElementById('sneakBtnLabel');
const btnMinimizeWindow = document.getElementById('btnMinimizeWindow');
const btnCloseAppWindow = document.getElementById('btnCloseAppWindow');

// Feature Toggles
const btnTranslateToggle = document.getElementById('btnTranslateToggle');
const translateBtnLabel = document.getElementById('translateBtnLabel');
const btnKaraokeToggle = document.getElementById('btnKaraokeToggle');
const btnLyricsBgToggle = document.getElementById('btnLyricsBgToggle');
const lyricsBgBtnLabel = document.getElementById('lyricsBgBtnLabel');

// Settings Modal
const btnSettingsModal = document.getElementById('btnSettingsModal');
const settingsModal = document.getElementById('settingsModal');
const clientIdInput = document.getElementById('clientIdInput');
const redirectUriInput = document.getElementById('redirectUriInput');
const displayRedirectUri = document.getElementById('displayRedirectUri');
const btnSaveSettings = document.getElementById('btnSaveSettings');
const btnCancelSettings = document.getElementById('btnCancelSettings');
const btnCloseSettings = document.getElementById('btnCloseSettings');

// Compatibility / Toast Elements
const appTitle = document.getElementById('appTitle');
const miniPlayer = document.getElementById('miniPlayer');
const lyricsContainer = document.getElementById('lyricsContainer');
const lyricsScrollBox = document.getElementById('lyricsScrollBox');
const lyricsPlaceholder = document.getElementById('lyricsPlaceholder');
const toastBanner = document.getElementById('toastBanner');
const toastIcon = document.getElementById('toastIcon');
const toastMessage = document.getElementById('toastMessage');

// Electron IPC Helper
function notifyWindowResize(height) {
  try {
    if (window.require) {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.send('resize-window', { width: 326, height: Math.ceil(height) });
    }
  } catch (err) {}
}

// Visual State Orchestrator (Idle vs Active vs Menu vs Search)
function updateWidgetVisualState() {
  if (isSearchOpen) {
    stealthWidget.classList.add('is-active');
    searchPalette.classList.remove('hidden');
    overflowMenu.classList.add('hidden');
    btnOverflowMenu.classList.remove('active');
    const isCollapsed = resultsContainer.classList.contains('collapsed');
    notifyWindowResize(isCollapsed ? 120 : 380);
    return;
  }

  searchPalette.classList.add('hidden');

  if (isMenuOpen) {
    stealthWidget.classList.add('is-active');
    overflowMenu.classList.remove('hidden');
    btnOverflowMenu.classList.add('active');
    notifyWindowResize(310);
    return;
  }

  overflowMenu.classList.add('hidden');
  btnOverflowMenu.classList.remove('active');

  if (isPinnedActive || isWidgetHovered) {
    stealthWidget.classList.add('is-active');
    notifyWindowResize(115);
  } else {
    stealthWidget.classList.remove('is-active');
    notifyWindowResize(46);
  }
}

// Toggle Pill Badges in Overflow Menu
function updatePillStates() {
  if (lyricsTogglePill) {
    lyricsTogglePill.textContent = isKaraokeActive ? 'ON' : 'OFF';
    lyricsTogglePill.className = `item-toggle-pill ${isKaraokeActive ? 'on' : 'off'}`;
  }
  if (translateTogglePill) {
    translateTogglePill.textContent = translationEnabled ? 'ON' : 'OFF';
    translateTogglePill.className = `item-toggle-pill ${translationEnabled ? 'on' : 'off'}`;
  }
  if (lyricsBgTogglePill) {
    lyricsBgTogglePill.textContent = lyricsBgEnabled ? 'ON' : 'OFF';
    lyricsBgTogglePill.className = `item-toggle-pill ${lyricsBgEnabled ? 'on' : 'off'}`;
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // Sync Session from Server
  await syncSessionFromServer();

  localStorage.setItem('spotify_client_id', spotifyClientId);
  localStorage.setItem('spotify_redirect_uri', spotifyRedirectUri);

  if (clientIdInput) clientIdInput.value = spotifyClientId;
  if (redirectUriInput) redirectUriInput.value = spotifyRedirectUri;
  if (displayRedirectUri) displayRedirectUri.textContent = spotifyRedirectUri;

  // Initial State: Idle Bar
  resultsContainer.classList.add('collapsed');
  updateWidgetVisualState();
  updatePillStates();

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
  if (syncBtnIcon) syncBtnIcon.classList.add('spinning');
  showToastNotification('🔄', 'Syncing with Spotify...');

  try {
    if (spotifyRefreshToken) {
      await refreshAccessToken();
    }
    consecutiveNullPolls = 0;
    currentTrackId = null;
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

function openSearchPalette() {
  isSearchOpen = true;
  isMenuOpen = false;
  updateWidgetVisualState();
  setTimeout(() => {
    if (searchInput) {
      searchInput.focus();
      searchInput.select();
    }
  }, 50);
}

function closeSearchPalette() {
  isSearchOpen = false;
  if (searchInput) searchInput.value = '';
  currentSearchResults = [];
  renderSearchResults([]);
  updateWidgetVisualState();
}

function setupEventListeners() {
  // Smooth JS Window Dragging without blocking click/hover events
  let isDragging = false;
  let dragStartX = 0, dragStartY = 0;
  let hasDragged = false;

  if (stealthWidget) {
    stealthWidget.addEventListener('mousedown', (e) => {
      if (e.target.closest('button') || e.target.closest('input') || e.target.closest('.no-drag') || e.target.closest('#overflowMenu') || e.target.closest('#searchPalette')) {
        return;
      }
      isDragging = true;
      hasDragged = false;
      dragStartX = e.screenX;
      dragStartY = e.screenY;
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const deltaX = e.screenX - dragStartX;
      const deltaY = e.screenY - dragStartY;
      if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
        hasDragged = true;
        dragStartX = e.screenX;
        dragStartY = e.screenY;
        if (window.require) {
          window.require('electron').ipcRenderer.send('move-window-by', { deltaX, deltaY });
        }
      }
    });

    document.addEventListener('mouseup', () => {
      setTimeout(() => { isDragging = false; }, 50);
    });
  }

  // Click on Idle Bar to Expand & Pin Big Player
  if (idleBar) {
    idleBar.addEventListener('click', (e) => {
      if (hasDragged) return;
      if (e.target.closest('button')) return;
      isPinnedActive = true;
      localStorage.setItem('spotify_pinned_active', 'true');
      updateWidgetVisualState();
    });
  }

  // Click on Collapse Button to Shrink to Mini Bar
  const btnCollapseBar = document.getElementById('btnCollapseBar');
  if (btnCollapseBar) {
    btnCollapseBar.addEventListener('click', (e) => {
      e.stopPropagation();
      isPinnedActive = false;
      localStorage.setItem('spotify_pinned_active', 'false');
      isMenuOpen = false;
      updateWidgetVisualState();
    });
  }

  // Click on Hide/Minimize Buttons to tuck away to System Tray (ย่อเก็บ)
  const btnIdleHide = document.getElementById('btnIdleHide');
  const btnActiveHide = document.getElementById('btnActiveHide');

  function hideAppToTray(e) {
    if (e) e.stopPropagation();
    if (window.require) {
      window.require('electron').ipcRenderer.send('hide-main-window');
    } else {
      window.close();
    }
  }

  if (btnIdleHide) btnIdleHide.addEventListener('click', hideAppToTray);
  if (btnActiveHide) btnActiveHide.addEventListener('click', hideAppToTray);

  // Hover transitions between State 1 (Idle) and State 2 (Active)
  if (stealthApp) {
    stealthApp.addEventListener('mouseenter', () => {
      clearTimeout(collapseTimer);
      isWidgetHovered = true;
      updateWidgetVisualState();
    });

    stealthApp.addEventListener('mouseleave', () => {
      collapseTimer = setTimeout(() => {
        isWidgetHovered = false;
        updateWidgetVisualState();
      }, 220);
    });

    // Mouse wheel anywhere on widget controls volume
    stealthApp.addEventListener('wheel', (e) => {
      if (e.target.closest('#settingsModal') || e.target.closest('#resultsContainer')) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 5 : -5;
      setVolume(currentVolume + delta);
    }, { passive: false });
  }

  // Overflow Menu Toggle (...)
  if (btnOverflowMenu) {
    btnOverflowMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      isMenuOpen = !isMenuOpen;
      if (isMenuOpen) isSearchOpen = false;
      updateWidgetVisualState();
    });
  }

  // Search Palette Trigger
  if (btnSearchTrigger) {
    btnSearchTrigger.addEventListener('click', () => {
      openSearchPalette();
    });
  }

  if (btnCloseSearch) {
    btnCloseSearch.addEventListener('click', () => {
      closeSearchPalette();
    });
  }

  // Search Input live typing
  if (searchInput) {
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
  }

  // Progress Bar Seek Interaction
  if (progressSection) {
    progressSection.addEventListener('click', (e) => {
      if (!currentTrackDuration) return;
      const rect = progressTrack.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const pct = Math.min(1, Math.max(0, clickX / rect.width));
      const targetMs = Math.round(pct * currentTrackDuration);
      spotifyApiCall(`/v1/me/player/seek?position_ms=${targetMs}`, 'PUT').then(success => {
        if (success) {
          currentTrackProgress = targetMs;
          lastProgressUpdate = Date.now();
          updateProgressUI();
        }
      });
    });
  }

  // Global Keyboard Shortcuts
  document.addEventListener('keydown', handleGlobalKeydown);

  // Sync / Reconnect
  if (btnForceReconnect) btnForceReconnect.addEventListener('click', forceSyncAndReconnect);
  if (statusBadge) statusBadge.addEventListener('click', forceSyncAndReconnect);

  // Settings
  if (btnSettingsModal) btnSettingsModal.addEventListener('click', showSettingsModal);
  if (btnCancelSettings) btnCancelSettings.addEventListener('click', hideSettingsModal);
  if (btnCloseSettings) btnCloseSettings.addEventListener('click', hideSettingsModal);
  if (btnSaveSettings) btnSaveSettings.addEventListener('click', saveSettings);
  if (btnRefreshDevices) btnRefreshDevices.addEventListener('click', refreshActiveDevices);

  // Translation Toggle
  if (btnTranslateToggle) {
    updateTranslateBtnState();
    btnTranslateToggle.addEventListener('click', toggleTranslation);
  }

  // Karaoke Toggle
  if (btnKaraokeToggle) {
    btnKaraokeToggle.addEventListener('click', toggleKaraoke);
  }

  // Lyrics Background Toggle
  if (btnLyricsBgToggle) {
    btnLyricsBgToggle.addEventListener('click', () => {
      if (window.require) {
        const { ipcRenderer } = window.require('electron');
        ipcRenderer.send('toggle-lyrics-bg');
      }
    });
  }

  // Electron IPC Listeners
  if (window.require) {
    try {
      const { ipcRenderer } = window.require('electron');
      
      ipcRenderer.on('toggle-search-palette', () => {
        if (isSearchOpen) {
          closeSearchPalette();
        } else {
          openSearchPalette();
        }
      });

      ipcRenderer.on('toggle-translation-hotkey', () => {
        toggleTranslation();
      });

      ipcRenderer.on('lyrics-bg-changed', (event, isEnabled) => {
        lyricsBgEnabled = isEnabled;
        showToastNotification(isEnabled ? '🖼️' : '⚪', isEnabled ? 'เปิดพื้นหลังเนื้อเพลงแล้ว' : 'ปิดพื้นหลังเนื้อเพลงแล้ว');
        if (lyricsBgBtnLabel) lyricsBgBtnLabel.textContent = isEnabled ? 'BG เปิด' : 'BG';
        updatePillStates();
      });

      ipcRenderer.on('lyrics-visibility-changed', (event, isVisible) => {
        isKaraokeActive = isVisible;
        updatePillStates();
      });
    } catch (e) {}
  }

  // Minimize (Panic Hide to Tray)
  if (btnMinimizeWindow) {
    btnMinimizeWindow.addEventListener('click', () => {
      if (window.require) {
        window.require('electron').ipcRenderer.send('hide-main-window');
      } else {
        window.close();
      }
    });
  }

  // Close (Exit App)
  if (btnCloseAppWindow) {
    btnCloseAppWindow.addEventListener('click', () => {
      if (window.require) {
        window.require('electron').ipcRenderer.send('quit-app');
      } else {
        window.close();
      }
    });
  }

  // Volume Slider
  if (volSlider) {
    volSlider.addEventListener('input', (e) => {
      setVolume(parseInt(e.target.value, 10));
    });
  }

  // Mute / Unmute
  if (btnMuteToggle) {
    btnMuteToggle.addEventListener('click', toggleMute);
  }

  // Player controls
  if (btnPlayPause) btnPlayPause.addEventListener('click', togglePlayPause);
  if (btnPrev) btnPrev.addEventListener('click', () => spotifyApiCall('/v1/me/player/previous', 'POST'));
  if (btnNext) btnNext.addEventListener('click', () => spotifyApiCall('/v1/me/player/next', 'POST'));
}

// Progress Scrub & Idle Timestamp UI Update
function updateProgressUI() {
  if (!currentTrackDuration) return;
  const elapsed = isPlaying ? (Date.now() - lastProgressUpdate) : 0;
  const currentMs = currentTrackProgress + elapsed;
  const pct = Math.min(100, Math.max(0, (currentMs / currentTrackDuration) * 100));
  
  if (progressFill) progressFill.style.width = pct + '%';

  if (idleStatus) {
    if (isPlaying) {
      const curSec = Math.floor(currentMs / 1000);
      const min = Math.floor(curSec / 60);
      const sec = String(curSec % 60).padStart(2, '0');
      idleStatus.textContent = `${min}:${sec}`;
    } else {
      idleStatus.textContent = 'Paused';
    }
  }
}

// Global Keydown Handler
function handleGlobalKeydown(e) {
  // Alt+Space -> Toggle On-Demand Search Palette
  if (e.altKey && (e.code === 'Space' || e.key === ' ')) {
    e.preventDefault();
    if (isSearchOpen) closeSearchPalette();
    else openSearchPalette();
    return;
  }

  // Alt+S -> Focus Search Input
  if (e.altKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    openSearchPalette();
    return;
  }

  // Alt+M -> Panic-Hide to Tray
  if (e.altKey && (e.key === 'm' || e.key === 'M')) {
    e.preventDefault();
    if (window.require) {
      window.require('electron').ipcRenderer.send('hide-main-window');
    }
    return;
  }

  // Lyrics Overlay Toggle Hotkeys
  if (e.altKey && (e.key === 'k' || e.key === 'K' || e.key === 'l' || e.key === 'L' || e.key === '\\' || e.code === 'Backslash' || e.keyCode === 220 || e.key === '`' || e.code === 'Backquote' || e.key === 'F9')) {
    e.preventDefault();
    toggleKaraoke();
    return;
  }

  // Alt+T -> Toggle Thai Translation
  if (e.altKey && (e.key === 't' || e.key === 'T' || e.code === 'KeyT')) {
    e.preventDefault();
    toggleTranslation();
    return;
  }

  // Alt+Up / Alt+Down -> Volume
  if (e.altKey && e.key === 'ArrowUp') {
    e.preventDefault();
    setVolume(currentVolume + 10);
    showToastNotification('🔊', `Volume: ${currentVolume}%`);
    return;
  }
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

  // Esc -> Close search, close menu, or panic hide
  if (e.key === 'Escape') {
    if (settingsModal && !settingsModal.classList.contains('hidden')) {
      hideSettingsModal();
    } else if (isSearchOpen) {
      closeSearchPalette();
    } else if (isMenuOpen) {
      isMenuOpen = false;
      updateWidgetVisualState();
    } else if (isPinnedActive) {
      isPinnedActive = false;
      localStorage.setItem('spotify_pinned_active', 'false');
      updateWidgetVisualState();
    } else {
      if (window.require) {
        window.require('electron').ipcRenderer.send('hide-main-window');
      }
    }
    return;
  }

  // Navigation inside Search Results
  if (isSearchOpen && currentSearchResults.length > 0) {
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
        closeSearchPalette();
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

// Sneak Mode Disguise Toggle
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

// Karaoke Overlay Toggle
function toggleKaraoke() {
  isKaraokeActive = !isKaraokeActive;
  updatePillStates();
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

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
    console.warn(`Spotify 429 Rate Limited (${retryAfter}s).`);
    return { isRateLimited: true, retryAfter };
  }

  if (res.status === 204) return true;
  if (!res.ok) return null;
  const textStr = await res.text();
  if (!textStr || !textStr.trim()) return true;
  try {
    return JSON.parse(textStr);
  } catch (err) {
    return true;
  }
}

// Search
async function performSearch(query) {
  const data = await spotifyApiCall(`/v1/search?q=${encodeURIComponent(query)}&type=track,artist,playlist&limit=4`);
  if (data) {
    const tracks = (data.tracks?.items || []).map(t => ({ ...t, type: 'track' }));
    const artists = (data.artists?.items || []).map(a => ({ ...a, type: 'artist' }));
    const playlists = (data.playlists?.items || []).map(p => ({ ...p, type: 'playlist' }));

    currentSearchResults = [...tracks, ...artists, ...playlists];
    selectedTrackIndex = currentSearchResults.length > 0 ? 0 : -1;
    renderSearchResults(currentSearchResults);
  }
}

function renderSearchResults(items) {
  trackList.innerHTML = '';
  if (items.length === 0) {
    resultsContainer.classList.add('collapsed');
    if (isSearchOpen) notifyWindowResize(120);
    return;
  }
  
  resultsContainer.classList.remove('collapsed');
  if (isSearchOpen) notifyWindowResize(380);

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
        <img class="track-art ${isArtist ? 'artist-avatar' : ''}" src="${artUrl || 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'30\' height=\'30\' viewBox=\'0 0 30 30\'%3E%3Crect width=\'30\' height=\'30\' fill=\'%23222\'/%3E%3C/svg%3E'}" alt="Art">
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
      closeSearchPalette();
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
  if (!state || !state.device) {
    await refreshActiveDevices();
    return;
  }

  if (state.is_playing) {
    await spotifyApiCall('/v1/me/player/pause', 'PUT');
    isPlaying = false;
    if (stealthWidget) stealthWidget.classList.remove('is-playing');
    playIconSvg.innerHTML = '<path d="M8 5v14l11-7z"/>';
    updateProgressUI();
  } else {
    await spotifyApiCall('/v1/me/player/play', 'PUT');
    isPlaying = true;
    if (stealthWidget) stealthWidget.classList.add('is-playing');
    playIconSvg.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
    lastProgressUpdate = Date.now();
    updateProgressUI();
  }
}

// Refresh Available Devices
async function refreshActiveDevices() {
  const data = await spotifyApiCall('/v1/me/player/devices');
  if (data && data.devices && data.devices.length > 0) {
    if (deviceAlert) deviceAlert.classList.add('hidden');
    const active = data.devices.find(d => d.is_active);
    if (!active && data.devices[0]) {
      await spotifyApiCall('/v1/me/player', 'PUT', { device_ids: [data.devices[0].id], play: false });
    }
  } else {
    if (deviceAlert) deviceAlert.classList.remove('hidden');
  }
}

// Synced Karaoke Lyrics Fetching Engine (Preserved exactly as-is)
async function fetchSyncedLyrics(track, artist, trackId, durationSec = null) {
  try {
    const res = await fetchBackendLyrics(track, artist, durationSec);
    if (res && res.lyrics) {
      parseLrcLines(res.lyrics);
      renderLyrics();
      return;
    }

    const cleanTrack = track.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '').replace(/-.*/g, '').trim();
    const cleanArtist = artist.split(',')[0].trim();
    const fallbackRes = await fetchBackendLyrics(cleanTrack, cleanArtist, durationSec);
    if (fallbackRes && fallbackRes.lyrics) {
      parseLrcLines(fallbackRes.lyrics);
      renderLyrics();
      return;
    }
  } catch (err) {
    console.error('Lyrics Fetch Error:', err);
  }

  showNoLyricsPlaceholder();
}

async function fetchBackendLyrics(track, artist, durationSec = null) {
  try {
    let url = `/api/lyrics?track=${encodeURIComponent(track)}&artist=${encodeURIComponent(artist)}`;
    if (durationSec) {
      url += `&duration=${Math.round(durationSec)}`;
    }
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

function showNoLyricsPlaceholder() {
  if (lyricsScrollBox) lyricsScrollBox.innerHTML = '<div class="lyrics-placeholder">No lyrics</div>';
  if (window.require) {
    const { ipcRenderer } = window.require('electron');
    ipcRenderer.send('update-lyric-text', 'No lyrics');
  }
}

let translationEnabled = localStorage.getItem('spotify_translation_enabled') !== 'false';

function updateTranslateBtnState() {
  if (translateBtnLabel) {
    translateBtnLabel.textContent = translationEnabled ? 'แปลเนื้อเพลงไทย' : 'ปิดแปลภาษา';
  }
  updatePillStates();
}

function toggleTranslation() {
  translationEnabled = !translationEnabled;
  localStorage.setItem('spotify_translation_enabled', translationEnabled);
  updateTranslateBtnState();
  showToastNotification(translationEnabled ? '🇹🇭' : '⚪', translationEnabled ? 'เปิดคำแปลไทยแล้ว (Alt+T)' : 'ปิดคำแปลไทยแล้ว (Alt+T)');
  renderLyrics();
  if (lyricsList.length > 0 && lastActiveIndex !== -1 && lyricsList[lastActiveIndex]) {
    const line = lyricsList[lastActiveIndex];
    const text = line.text || '';
    if (text) {
      if (translationEnabled) {
        if (line.translation) {
          updateOverlayLyricText({ original: text, translation: line.translation });
        } else if (!/[\u0E00-\u0E7F]/.test(text)) {
          fetchLineTranslation(text).then(trans => {
            if (trans) line.translation = trans;
            if (translationEnabled && lastActiveIndex !== -1 && lyricsList[lastActiveIndex] === line) {
              updateOverlayLyricText(trans ? { original: text, translation: trans } : text);
            }
          });
        } else {
          updateOverlayLyricText(text);
        }
      } else {
        updateOverlayLyricText(text);
      }
    }
  }
}

async function fetchLineTranslation(text) {
  if (!text || !text.trim() || /[\u0E00-\u0E7F]/.test(text)) return '';
  try {
    if (window.require) {
      const { ipcRenderer } = window.require('electron');
      return await ipcRenderer.invoke('get-translation', text);
    } else {
      const res = await fetch(`/api/translate?text=${encodeURIComponent(text)}`);
      if (res.ok) {
        const data = await res.json();
        return data.translation || '';
      }
    }
  } catch (err) {}
  return '';
}

function renderLyrics() {
  if (!lyricsScrollBox) return;
  lyricsScrollBox.innerHTML = '';
  if (lyricsList.length === 0) {
    showNoLyricsPlaceholder();
    return;
  }

  lyricsList.forEach((line, index) => {
    const el = document.createElement('div');
    el.className = 'lyric-line';
    el.id = `lyric-line-${index}`;

    const origEl = document.createElement('div');
    origEl.className = 'lyric-orig';
    origEl.textContent = line.text || '🎵';
    el.appendChild(origEl);

    if (translationEnabled && line.text && !/[\u0E00-\u0E7F]/.test(line.text)) {
      const transEl = document.createElement('div');
      transEl.className = 'lyric-translation';
      el.appendChild(transEl);

      if (line.translation) {
        transEl.textContent = line.translation;
      } else {
        setTimeout(() => {
          if (!translationEnabled) return;
          fetchLineTranslation(line.text).then(trans => {
            if (trans) {
              line.translation = trans;
              transEl.textContent = trans;
            }
          });
        }, index * 40);
      }
    }

    lyricsScrollBox.appendChild(el);
  });
}

// 450ms pre-roll lead-time for synced lyrics
const KARAOKE_LEAD_OFFSET = 450;
let currentDisplayedLyric = null;
let lastPreRollIndex = -1;

function startLocalLyricsClock() {
  if (lyricsSyncTimer) clearInterval(lyricsSyncTimer);
  lastPreRollIndex = -1;
  lyricsSyncTimer = setInterval(() => {
    if (!isPlaying) return;

    // Continuously update progress bar and idle timestamp
    updateProgressUI();

    if (lyricsList.length === 0) return;

    const elapsed = Date.now() - lastProgressUpdate;
    const currentMs = currentTrackProgress + elapsed + KARAOKE_LEAD_OFFSET;

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

      if (age > 3600 && age > (gap * 0.7) && nextLine && nextLine.text) {
        if (lastPreRollIndex !== activeIndex + 1) {
          lastPreRollIndex = activeIndex + 1;
          if (translationEnabled && nextLine.text && !/[\u0E00-\u0E7F]/.test(nextLine.text)) {
            if (nextLine.translation) {
              updateOverlayLyricText({ original: nextLine.text, translation: nextLine.translation });
            } else {
              fetchLineTranslation(nextLine.text).then(nextTrans => {
                if (nextTrans) nextLine.translation = nextTrans;
                updateOverlayLyricText(nextTrans ? { original: nextLine.text, translation: nextTrans } : nextLine.text);
              });
            }
          } else {
            updateOverlayLyricText(nextLine.text);
          }
        }
      } else {
        lastPreRollIndex = -1;
        updateActiveLyricLine(activeIndex);
      }
    }
  }, 100);
}

let lastActiveIndex = -1;
function updateActiveLyricLine(activeIndex) {
  if (!lyricsScrollBox) return;
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
    const line = lyricsList[activeIndex];
    let activeText = line?.text || '';
    if (!activeText.trim()) activeText = '♪ ... ♪';

    if (translationEnabled && activeText && !/[\u0E00-\u0E7F]/.test(activeText)) {
      if (line && line.translation) {
        updateOverlayLyricText({ original: activeText, translation: line.translation });
      } else {
        fetchLineTranslation(activeText).then(trans => {
          if (trans && line) line.translation = trans;
          const payload = trans ? { original: activeText, translation: trans } : activeText;
          updateOverlayLyricText(payload);
        });
      }
    } else {
      updateOverlayLyricText(activeText);
    }
  }
}

function updateOverlayLyricText(text) {
  const serialized = typeof text === 'object' ? JSON.stringify(text) : String(text);
  if (currentDisplayedLyric !== serialized) {
    currentDisplayedLyric = serialized;
    if (window.require) {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.send('update-lyric-text', text);
    }
  }
}

// Currently Playing Polling
function startNowPlayingPolling() {
  fetchCurrentlyPlaying();
  if (nowPlayingInterval) clearInterval(nowPlayingInterval);
  nowPlayingInterval = setInterval(fetchCurrentlyPlaying, 3500);
}

let consecutiveNullPolls = 0;

async function fetchCurrentlyPlaying() {
  const data = await spotifyApiCall('/v1/me/player/currently-playing');
  if (data && data.isRateLimited) {
    return;
  }
  if (data && data.item) {
    consecutiveNullPolls = 0;
    
    // Active State details (Image 2)
    playerTitle.textContent = data.item.name;
    playerArtist.textContent = data.item.artists.map(a => a.name).join(', ');
    
    // Idle State details (Image 1)
    if (idleSubtitle) idleSubtitle.textContent = (data.item.artists[0]?.name || 'Artist/Song').toUpperCase();
    if (idleTitle) idleTitle.textContent = data.item.name;

    currentTrackDuration = data.item.duration_ms || 1;
    currentTrackProgress = data.progress_ms || 0;
    lastProgressUpdate = Date.now();
    isPlaying = data.is_playing;

    const art = data.item.album.images[2]?.url || data.item.album.images[0]?.url;
    if (art) playerAlbumArt.src = art;

    if (stealthWidget) {
      if (isPlaying) {
        stealthWidget.classList.add('is-playing');
      } else {
        stealthWidget.classList.remove('is-playing');
      }
    }

    // Play/Pause Icon
    if (data.is_playing) {
      playIconSvg.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
    } else {
      playIconSvg.innerHTML = '<path d="M8 5v14l11-7z"/>';
    }

    updateProgressUI();

    if (data.item.id !== currentTrackId) {
      currentTrackId = data.item.id;
      const durSec = data.item.duration_ms ? data.item.duration_ms / 1000 : null;
      fetchSyncedLyrics(data.item.name, data.item.artists[0].name, data.item.id, durSec);
    }
  } else {
    consecutiveNullPolls++;
    if (consecutiveNullPolls >= 8) {
      playerTitle.textContent = 'Not Playing';
      playerArtist.textContent = 'Spotify Idle';
      if (idleSubtitle) idleSubtitle.textContent = 'SPOTIFY';
      if (idleTitle) idleTitle.textContent = 'Idle';
      if (idleStatus) idleStatus.textContent = 'Idle';
      if (stealthWidget) stealthWidget.classList.remove('is-playing');
      if (progressFill) progressFill.style.width = '0%';
      playIconSvg.innerHTML = '<path d="M8 5v14l11-7z"/>';
      isPlaying = false;
      currentTrackId = '';
      lyricsList = [];
      if (lyricsScrollBox) lyricsScrollBox.innerHTML = '<div class="lyrics-placeholder">Waiting for music to play...</div>';
      if (window.require) {
        const { ipcRenderer } = window.require('electron');
        ipcRenderer.send('update-lyric-text', 'Waiting for music...');
      }
    }
  }
}

// Connection Badge
function updateConnectionStatus(isConnected, text) {
  if (statusBadge) {
    if (isConnected) {
      statusBadge.classList.add('connected');
    } else {
      statusBadge.classList.remove('connected');
    }
  }
  if (statusText) statusText.textContent = text;
}

// Settings Modal
function showSettingsModal() { 
  if (settingsModal) settingsModal.classList.remove('hidden'); 
  notifyWindowResize(380);
}
function hideSettingsModal() { 
  if (settingsModal) settingsModal.classList.add('hidden'); 
  updateWidgetVisualState();
}

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
  }, 2200);
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Single Key Shortcut (\ or ฃ key) to toggle floating lyrics window
document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (e.key === '\\' || e.key === 'ฃ' || e.code === 'Backslash') {
    if (window.require) {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.send('toggle-lyrics');
    }
  }
});
