const fs = require('fs');
const path = require('path');
const { Agent, setGlobalDispatcher } = require('./node_modules/undici');
const dns = require('dns').promises;

// Use Google & Cloudflare DNS to avoid internal DNS timeout issues
dns.setServers(['8.8.8.8', '1.1.1.1']);
setGlobalDispatcher(new Agent({
  connect: {
    lookup: (h, o, cb) => {
      if (typeof o === 'function') { cb = o; o = {}; }
      dns.resolve4(h).then(a => {
        if (o && o.all) cb(null, a.map(ip => ({ address: ip, family: 4 })));
        else cb(null, a[0], 4);
      }).catch(cb);
    }
  }
}));

const SESSION_FILE = path.join(__dirname, 'session.json');
const HISTORY_DIR = path.join(__dirname, 'my_spotify_data', 'Spotify Extended Streaming History');
const SHOW_ID = '2nKedRmKdZJjVTi3ddHbsZ'; // The Ghost Radio

async function getAccessToken() {
  if (!fs.existsSync(SESSION_FILE)) throw new Error('session.json not found');
  const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  let token = session.spotify_access_token;

  let res = await fetch('https://api.spotify.com/v1/me/player', {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (res.status === 401 && session.spotify_refresh_token && session.spotify_client_id) {
    const refreshRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: session.spotify_client_id,
        grant_type: 'refresh_token',
        refresh_token: session.spotify_refresh_token
      })
    });
    const refreshData = await refreshRes.json();
    if (refreshData.access_token) {
      token = refreshData.access_token;
      session.spotify_access_token = token;
      fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
    }
  }
  return token;
}

const QUEUED_HISTORY_FILE = path.join(__dirname, 'queued_history.json');

function loadHistory() {
  const uris = new Set();
  const storyNames = new Set();
  const epNumbers = new Set();
  const fullTitles = new Set();

  if (fs.existsSync(HISTORY_DIR)) {
    const files = fs.readdirSync(HISTORY_DIR).filter(f => f.startsWith('Streaming_History_') && f.endsWith('.json'));
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8'));
        for (const item of data) {
          const isGhost = (item.episode_show_name && /ghost/i.test(item.episode_show_name)) ||
                          (item.master_metadata_album_artist_name && /ghost/i.test(item.master_metadata_album_artist_name)) ||
                          (item.master_metadata_album_album_name && /ghost/i.test(item.master_metadata_album_album_name));
          if (isGhost) {
            if (item.spotify_episode_uri) uris.add(item.spotify_episode_uri);
            if (item.spotify_track_uri) uris.add(item.spotify_track_uri);
            const name = item.episode_name || item.master_metadata_track_name;
            if (name) {
              fullTitles.add(name.trim().toLowerCase());
              const epMatch = name.match(/ep\.?\s*(\d+)/i);
              if (epMatch) epNumbers.add(parseInt(epMatch[1], 10));

              const match = name.match(/ep\.?\s*\d+\s+([^-|]+)/i);
              if (match) {
                const story = match[1].trim().toLowerCase().replace(/\s+/g, ' ');
                if (story.length > 1) storyNames.add(story);
              }
            }
          }
        }
      } catch (e) {}
    }
  }

  if (fs.existsSync(QUEUED_HISTORY_FILE)) {
    try {
      const qData = JSON.parse(fs.readFileSync(QUEUED_HISTORY_FILE, 'utf8'));
      for (const item of qData) {
        if (item.uri) uris.add(item.uri);
        const name = item.name;
        if (name) {
          fullTitles.add(name.trim().toLowerCase());
          const epMatch = name.match(/ep\.?\s*(\d+)/i);
          if (epMatch) epNumbers.add(parseInt(epMatch[1], 10));

          const match = name.match(/ep\.?\s*\d+\s+([^-|]+)/i);
          if (match) {
            const story = match[1].trim().toLowerCase().replace(/\s+/g, ' ');
            if (story.length > 1) storyNames.add(story);
          }
        }
      }
    } catch (e) {}
  }

  return { uris, storyNames, epNumbers, fullTitles };
}

function extractStoryName(title) {
  const match = title.match(/ep\.?\s*\d+\s+([^-|]+)/i);
  if (match) return match[1].trim().toLowerCase().replace(/\s+/g, ' ');
  return title.trim().toLowerCase();
}

function isPlayed(ep, history) {
  if (history.uris.has(ep.uri) || history.uris.has(`spotify:episode:${ep.id}`)) return true;
  const epMatch = ep.name.match(/ep\.?\s*(\d+)/i);
  if (epMatch && history.epNumbers.has(parseInt(epMatch[1], 10))) return true;
  const clean = ep.name.trim().toLowerCase();
  if (history.fullTitles.has(clean)) return true;
  const story = extractStoryName(ep.name);
  if (history.storyNames.has(story)) return true;
  return false;
}

async function fetchEpisodes(token, count = 250) {
  const eps = [];
  for (let offset = 0; offset < count; offset += 50) {
    const res = await fetch(`https://api.spotify.com/v1/shows/${SHOW_ID}/episodes?market=TH&limit=50&offset=${offset}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!data.items || data.items.length === 0) break;
    eps.push(...data.items);
  }
  return eps;
}

async function runAutoQueue(targetHour = 16, targetMinute = 45, force = false) {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sun, 5 = Fri, 6 = Sat
  if (!force && (dayOfWeek === 0 || dayOfWeek === 5 || dayOfWeek === 6)) {
    console.log(`[AutoQueue] Today is day ${dayOfWeek} (Fri/Sat/Sun). Skipping queue as configured (use --force to override).`);
    return;
  }

  const token = await getAccessToken();
  const history = loadHistory();

  // Get active device
  const devRes = await fetch('https://api.spotify.com/v1/me/player/devices', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const devData = await devRes.json();
  const activeDevice = (devData.devices || []).find(d => d.is_active) || (devData.devices || [])[0];
  const deviceParam = activeDevice ? `&device_id=${activeDevice.id}` : '';
  console.log(`[AutoQueue] Target device: ${activeDevice?.name} (${activeDevice?.id})`);

  // Check currently playing item
  let currentPlayingRemainingMs = 0;
  let currentlyPlayingUri = null;
  let currentlyPlayingName = null;
  try {
    const pRes = await fetch('https://api.spotify.com/v1/me/player?additional_types=episode', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (pRes.status === 200) {
      const pData = await pRes.json();
      if (pData.item) {
        if (pData.item.type === 'episode' || pData.item.uri?.startsWith('spotify:episode')) {
          currentlyPlayingUri = pData.item.uri;
        }
        currentlyPlayingName = pData.item.name;
        if (pData.is_playing) {
          currentPlayingRemainingMs = Math.max(0, pData.item.duration_ms - (pData.progress_ms || 0));
        }
        console.log(`[AutoQueue] Currently playing: "${currentlyPlayingName}" (${pData.item.type || 'track'}, Remaining: ${(currentPlayingRemainingMs / 60000).toFixed(1)} mins)`);
      }
    }
  } catch (err) {
    console.warn('[AutoQueue] Failed to get player state:', err.message);
  }

  // Check current queue
  const qRes = await fetch('https://api.spotify.com/v1/me/player/queue', {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const qData = await qRes.json();
  const currentQueueEpisodes = [];
  for (const q of (qData.queue || [])) {
    if (q.type === 'episode' || (q.uri && q.uri.startsWith('spotify:episode'))) {
      currentQueueEpisodes.push(q);
    } else {
      break; // Stop at music tracks
    }
  }

  let currentQueueDurationMs = 0;
  for (const q of currentQueueEpisodes) {
    currentQueueDurationMs += q.duration_ms;
  }

  const totalCurrentGhostMs = currentPlayingRemainingMs + currentQueueDurationMs;

  const targetTime = new Date(now);
  targetTime.setHours(targetHour, targetMinute, 0, 0);
  const totalWindowMs = targetTime.getTime() - now.getTime();
  const neededMs = totalWindowMs - totalCurrentGhostMs;

  console.log(`[AutoQueue] Current time: ${now.toLocaleTimeString('th-TH')}`);
  console.log(`[AutoQueue] Target time: ${targetTime.toLocaleTimeString('th-TH')}`);
  console.log(`[AutoQueue] Current Ghost in queue: ${currentQueueEpisodes.length} episodes (${(currentQueueDurationMs / 60000).toFixed(1)} mins)`);
  console.log(`[AutoQueue] Total playback before new queue: ${(totalCurrentGhostMs / 60000).toFixed(1)} mins`);
  console.log(`[AutoQueue] Needed duration: ${(neededMs / 60000).toFixed(1)} mins`);

  if (neededMs <= 180000) { // less than 3 mins needed
    console.log('[AutoQueue] Current queue already covers duration. No additional episodes needed.');
    return;
  }

  const fetched = await fetchEpisodes(token, 300);
  const alreadyQueuedUris = new Set(currentQueueEpisodes.map(q => q.uri));
  if (currentlyPlayingUri) alreadyQueuedUris.add(currentlyPlayingUri);

  const unplayed = fetched.filter(ep => !isPlayed(ep, history) && !alreadyQueuedUris.has(ep.uri));
  console.log(`[AutoQueue] Unplayed candidate episodes found: ${unplayed.length}`);

  const candidatePool = unplayed.slice(0, 60);
  const sortedCandidates = [...candidatePool].sort((a, b) => b.duration_ms - a.duration_ms);
  let bestCombo = null;
  let bestDiff = Infinity;

  function search(idx, currentCombo, currentSum) {
    const diff = Math.abs(currentSum - neededMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestCombo = [...currentCombo];
      if (bestDiff < 15000) return true; // Stop early if within 15 seconds
    }
    if (currentSum >= neededMs + bestDiff) return false;
    if (currentCombo.length >= 8) return false;

    for (let i = idx; i < sortedCandidates.length; i++) {
      if (currentSum + sortedCandidates[i].duration_ms > neededMs + bestDiff) continue;
      currentCombo.push(sortedCandidates[i]);
      const exact = search(i + 1, currentCombo, currentSum + sortedCandidates[i].duration_ms);
      currentCombo.pop();
      if (exact) return true;
    }
    return false;
  }

  search(0, [], 0);

  if (!bestCombo || bestCombo.length === 0) {
    console.log('[AutoQueue] No suitable combination found.');
    return;
  }

  let totalComboDurationMs = 0;
  console.log(`[AutoQueue] Adding ${bestCombo.length} episode(s) to queue:`);
  for (const ep of bestCombo) {
    const url = `https://api.spotify.com/v1/me/player/queue?uri=${encodeURIComponent(ep.uri)}${deviceParam}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    totalComboDurationMs += ep.duration_ms;
    console.log(`- ${ep.name} (${(ep.duration_ms / 60000).toFixed(1)} min) -> Status: ${res.status}`);
    await new Promise(r => setTimeout(r, 350));
  }

  // Record queued history to avoid playing again in the future
  try {
    let qHist = [];
    if (fs.existsSync(QUEUED_HISTORY_FILE)) {
      qHist = JSON.parse(fs.readFileSync(QUEUED_HISTORY_FILE, 'utf8'));
    }
    for (const ep of bestCombo) {
      qHist.push({
        uri: ep.uri,
        name: ep.name,
        duration_ms: ep.duration_ms,
        queued_at: new Date().toISOString()
      });
    }
    fs.writeFileSync(QUEUED_HISTORY_FILE, JSON.stringify(qHist, null, 2));
  } catch (e) {
    console.warn('[AutoQueue] Failed to record queued_history.json:', e.message);
  }

  const projectedEndTime = new Date(now.getTime() + totalCurrentGhostMs + totalComboDurationMs);
  console.log(`[AutoQueue] Total added: ${(totalComboDurationMs / 60000).toFixed(1)} mins`);
  console.log(`[AutoQueue] Projected end time: ${projectedEndTime.toLocaleTimeString('th-TH')}`);
  console.log('[AutoQueue] All episodes enqueued successfully!');
  return { bestCombo, projectedEndTime, totalComboDurationMs };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let h = 16, m = 45;
  let force = false;

  for (const arg of args) {
    if (arg === '--force' || arg === '-f') {
      force = true;
    } else if (arg.includes(':')) {
      const parts = arg.split(':');
      h = parseInt(parts[0], 10);
      m = parseInt(parts[1], 10);
    }
  }

  runAutoQueue(h, m, force).catch(console.error);
}

module.exports = { runAutoQueue, getAccessToken, loadHistory, isPlayed, fetchEpisodes };

