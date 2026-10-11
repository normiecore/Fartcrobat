# Fartcrobat

A free, open-source PDF reader, editor and signer for Windows, macOS and Linux, designed so people
coming from Adobe Acrobat Pro feel at home.

> Work in progress. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the app is built.

## Development

```
npm install
npm run dev        # run the app with hot reload
npm test           # engine unit tests
npm run e2e        # build and run end-to-end tests (Linux: prefix with xvfb-run -a)
npm run dist       # build installers for the current platform
```

## License

Fartcrobat is licensed under the GNU Affero General Public License v3.0 or later. It uses
[MuPDF](https://mupdf.com) by Artifex Software, also under the AGPL.
