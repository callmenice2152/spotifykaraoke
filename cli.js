// Spotify Stealth Bar CLI Controller for AI Assistant
const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, 'session.json');

async function getAccessToken() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  let token = session.spotify_access_token;

  // Try API call to test token
  let res = await fetch('https://api.spotify.com/v1/me/player', {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (res.status === 401 && session.spotify_refresh_token && session.spotify_client_id) {
    // Refresh token
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

async function apiCall(endpoint, method = 'GET', body = null) {
  const token = await getAccessToken();
  if (!token) {
    console.log('Error: No Spotify session found. Please log in first.');
    return null;
  }

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`https://api.spotify.com${endpoint}`, options);
  if (res.status === 204) return true;
  
  const text = await res.text();
  if (!text) return true;
  try {
    return JSON.parse(text);
  } catch (e) {
    return true;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();
  const param = args.slice(1).join(' ');

  if (!command) {
    console.log('Usage: node cli.js <play|queue|pause|next|prev|volume|current> [query|value]');
    return;
  }

  if (command === 'play') {
    if (param) {
      // Search track/artist/playlist first
      const searchData = await apiCall(`/v1/search?q=${encodeURIComponent(param)}&type=track,artist,playlist&limit=1`);
      if (searchData && typeof searchData === 'object') {
        const track = searchData.tracks?.items[0];
        const artist = searchData.artists?.items[0];
        const playlist = searchData.playlists?.items[0];

        const target = track || artist || playlist;
        if (target) {
          const body = target.type === 'track' ? { uris: [target.uri] } : { context_uri: target.uri };
          await apiCall('/v1/me/player/play', 'PUT', body);
          console.log(`▶️ Played ${target.type}: "${target.name}"`);
        } else {
          console.log(`No results found for "${param}"`);
        }
      }
    } else {
      await apiCall('/v1/me/player/play', 'PUT');
      console.log('▶️ Resumed Playback');
    }
  } else if (command === 'queue') {
    if (param) {
      const searchData = await apiCall(`/v1/search?q=${encodeURIComponent(param)}&type=track&limit=1`);
      if (searchData && searchData.tracks?.items[0]) {
        const track = searchData.tracks.items[0];
        await apiCall(`/v1/me/player/queue?uri=${encodeURIComponent(track.uri)}`, 'POST');
        console.log(`➕ Queued track: "${track.name}" by ${track.artists.map(a => a.name).join(', ')}`);
      } else {
        console.log(`No track found to queue for "${param}"`);
      }
    }
  } else if (command === 'pause') {
    await apiCall('/v1/me/player/pause', 'PUT');
    console.log('⏸️ Paused Playback');
  } else if (command === 'next') {
    await apiCall('/v1/me/player/next', 'POST');
    console.log('⏭️ Skipped to Next Track');
  } else if (command === 'prev') {
    await apiCall('/v1/me/player/previous', 'POST');
    console.log('⏮️ Went to Previous Track');
  } else if (command === 'volume') {
    const vol = parseInt(param, 10);
    if (!isNaN(vol)) {
      await apiCall(`/v1/me/player/volume?volume_percent=${vol}`, 'PUT');
      console.log(`🔊 Set Volume to ${vol}%`);
    }
  } else if (command === 'current') {
    const data = await apiCall('/v1/me/player/currently-playing');
    if (data && data.item) {
      console.log(`🎵 Currently Playing: "${data.item.name}" by ${data.item.artists.map(a => a.name).join(', ')}`);
    } else {
      console.log('Spotify is currently idle.');
    }
  }
}

main();
