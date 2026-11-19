# Glance

An always-on display for the iPad: a dot-matrix clock, whatever your Mac is playing, and time-synced lyrics over a blurred album-art backdrop.

## Run

```sh
brew install media-control   # once; reads the Mac's "now playing" from any app
npm start
```

Open the printed address in Safari on the iPad (same Wi-Fi as the Mac), then **Share → Add to Home Screen** and launch it from there for full screen.

On the iPad, set **Settings → Display & Brightness → Auto-Lock → Never** so it stays on.

## Using it

- Tap anywhere to reveal the gear (top right): clock format, background, night dimming, lyric timing, weather city.
- Tap a lyric line or the progress dots to seek; the buttons control playback on the Mac.
- Put your own images in `wallpapers/` and choose **Photos** as the background.
- Two minutes after you pause, it falls back to the big clock.

Lyrics come from [LRCLIB](https://lrclib.net) and are cached in `.cache/`. Weather comes from Open-Meteo.
