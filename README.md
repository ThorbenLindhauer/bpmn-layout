# bpmn-layout

Automatically layout BPMN models using the [ELK](https://eclipse.dev/elk/) layered algorithm.

Takes a BPMN XML string, computes left-to-right layout coordinates via `elkjs`, updates the
BPMN Diagram Interchange (DI), and returns the result as a BPMN XML string.

## Disclaimer

This project has been largely vibe-coded with Claude Code. Most of the code has not been reviewed in depth by a human.

## Requirements

**Node.js 18 or later** is required. This is the minimum version supported by the build
toolchain (Vite 5, vitest 1). `??=` and other ES2021 operators used internally by those tools
require at least Node 15, but Node 18 is the practical floor.

If you use [nvm](https://github.com/nvm-sh/nvm), run `nvm use` in the project root — the
included `.nvmrc` pins the version to Node 18.

## Installation

```sh
npm install bpmn-layout
```

## Usage

```ts
import { layout } from 'bpmn-layout';

const xml = '...'; // raw BPMN 2.0 XML string
const laidOutXml = await layout(xml);
```

The returned string is valid BPMN 2.0 XML with `BPMNShape` and `BPMNEdge` elements populated
with absolute coordinates. Any pre-existing DI is replaced.

## Building the package

```sh
npm install
npm run build
```

Output is written to `dist/`:
- `dist/index.js` — ES module
- `dist/index.cjs` — CommonJS
- `dist/index.d.ts` — TypeScript declarations

## Running the tests

Tests are written with [Vitest](https://vitest.dev/) following a red/green TDD workflow.

```sh
npm test            # single run
npm run test:watch  # watch mode
```

## Running the demo locally

The demo is a client-side web page that lets you upload a `.bpmn` file, apply auto-layout,
preview the result in a [bpmn-js](https://bpmn.io/toolkit/bpmn-js/) viewer, and save the
laid-out diagram.

```sh
npm run demo
```

Then open <http://localhost:5173> in your browser.

### Demo workflow

1. Click **Choose .bpmn file…** and select any BPMN 2.0 file.
2. Click **Apply Layout** — the diagram is re-rendered with computed coordinates.
3. Click **↓ Save .bpmn** to download the result.
