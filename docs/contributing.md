# Contributing

Bug reports and pull requests are welcome on [GitHub](https://github.com/ernilambar/glot-cli).

1. Fork the repo and create your branch from `main`.
2. Make your changes and test locally with `node --test`.
3. Open a pull request with a clear description of what changed and why.

## Manual Testing

Before opening a PR, verify the key commands against a real `.po` file:

```bash
node src/index.ts status path/to/file.po
node src/index.ts translate path/to/file.po --lang ne_NP --limit 1
node src/index.ts review path/to/file.pot
node src/index.ts glossary pull ne_NP
node src/index.ts glossary list
node src/index.ts core pull ne_NP
node src/index.ts core list
node src/index.ts translations import path/to/file.po --lang ne_NP
node src/index.ts translations list
node src/index.ts browse path/to/file.po --no-open  # starts a server; Ctrl+C to stop
node src/index.ts serve  # starts the REST API; Ctrl+C to stop
```
