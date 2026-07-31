# Installation

**macOS** — Homebrew:

```bash
brew tap ernilambar/tap
brew trust ernilambar/tap
brew install ernilambar/tap/glot
glot --version
```

**macOS** — prebuilt binary (replace `arm64` with `amd64` for Intel Macs):

```bash
curl -fL -o glot https://github.com/ernilambar/glot-cli/releases/latest/download/glot-darwin-arm64
xattr -d com.apple.quarantine glot 2>/dev/null || true
chmod +x glot
sudo mv glot /usr/local/bin/
glot --version
```

**From source** (requires Node.js 22.18+ and [Bun](https://bun.sh)):

```bash
git clone https://github.com/ernilambar/glot-cli.git
cd glot-cli
bun install
bun run build
sudo mv dist/glot /usr/local/bin/
```
