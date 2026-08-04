# 🎵 Spotify Karaoke Floating Overlay & Quick Bar

A sleek, lightweight Electron desktop application that displays real-time synced lyrics floating seamlessly on your screen for Spotify music playback. 🎤✨

---

## ✨ Features

- 🎤 **Floating Lyrics Overlay**: Transparent, borderless window displaying real-time synced lyrics directly over your desktop.
- 🇹🇭 🌐 **Multi-Source Lyrics Engine**: Supports full LRC sentence lyrics for both Asian/Thai and International songs.
- ⏱️ **Smart Lead & Gap Clearing**: Anticipates upcoming lyric lines and automatically clears old lines during instrumental breaks.
- 🔒 **Zero-Config OAuth PKCE Security**: Secure authentication without exposing secret keys.

---

## 🚀 Setup Guide

### 1. Get a Free Spotify Client ID (1 Minute)
- Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
- Click **Create app**.
- Set the **Redirect URI** to: `http://127.0.0.1:3000/callback` and click **Save**.
- Copy your **Client ID**.

### 2. Environment Configuration (Optional)
- Copy `.env.example` to `.env`.
- Paste your Client ID:
  ```env
  SPOTIFY_CLIENT_ID=your_client_id_here
  ```

### 3. Run the Application
```bash
npm install
npx electron .
```
- Open the application, click the **Settings (⚙️)** icon, paste your Client ID, and click **Save & Login**.
