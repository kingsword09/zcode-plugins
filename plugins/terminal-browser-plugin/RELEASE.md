terminal-browser is distributed as a versioned GitHub Release ZIP containing the
MCP server, recording worker, required Playwright runtime, axe script, portable
WASM recording codecs, commands, skills, and dependency licenses. Installation
requires no build or npm install; WebM recording needs no external FFmpeg.

The marketplace entry references the immutable version URL and its SHA-256.
The release workflow checks types, tests the source, and runs the full Chromium
integration suite against the extracted ZIP. It downloads the published ZIP and
checks its SHA-256 before proposing this marketplace update.
