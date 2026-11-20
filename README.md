# Stripboard Optimiser

A browser app that turns a netlist into a buildable **stripboard (Veroboard) layout**. It chooses component positions and orientations, then works out the **track cuts** and **wire links**, so you get a layout you can solder from a printed build sheet.

It runs entirely client-side (Vite + React + TypeScript). The optimiser runs in Web Workers, so a static host such as GitHub Pages is enough.

## Background

[arXiv:2512.04910](https://arxiv.org/html/2512.04910v1) treats stripboard layout as an Answer Set Programming problem. Its model:
- gives each pin one hole, with no part footprints
- forces every net onto a single strip
- minimises total strip distance (TD), then area, then width

It leaves track cuts, wire links and rotation as future work. Under its single-strip rule, common circuits are infeasible: the 555's VCC pins 4 and 8 can never share a strip.

This app adds what that model is missing:

- **Real footprints with rotation.** Supported: axial parts with a variable lead span, radial cans, DIP, SIP/headers, TO-92/TO-220, pots and wire pads.
- **Cut derivation.** On each strip, every change of net between neighbouring pins needs one cut in a hole that is free (or between two holes if you choose that cut mode).
- **Link routing.** If a net ends up on several strips, its pieces are joined with straight vertical links. The router uses Kruskal over strip pairs, keeps link wires clear of pins, bodies and other links, and leaves a cuttable hole in each gap.
- **An independent verifier.** It simulates the copper as union-find over holes, splitting strips at cuts and joining them through links. It then checks connectivity against the netlist: no open nets, no shorts, no overlaps, and nothing off the board.
- **Simulated annealing.** The search moves, rotates, re-spans and swaps parts, and also snaps a pin onto a strip its net already uses. The cost is a weighted sum of penalties (unrouted connections, shorts, overlaps) plus board area, cuts, links and link length. The paper's TD metric is reported alongside the other results, and you can weight it if you want.

## Using it

```bash
npm install
```

```bash
npm run dev
```

Pick an example or type a netlist, then press **Optimise**. Drag parts to adjust the layout by hand: <kbd>R</kbd> rotates, <kbd>[</kbd>/<kbd>]</kbd> changes the lead span, and the arrow keys nudge. **Refine current** anneals gently, starting from your edits. Use **Copper side** to see the mirrored view you will cut from. Export as SVG/PNG, a text build sheet, or a JSON project.

### Netlist format

```
# comment
board 20x30                          # optional: strips x holes
U1 dip8 NE555 1=GND 2=THR 3=OUT 4=VCC 5=CV 6=THR 7=DIS 8=VCC
R1 axial(4-8) 1k 1=VCC 2=DIS         # REF FOOTPRINT [VALUE] pin=NET ...
C1 radial(2) 10u 1=THR 2=GND
J1 header2 PWR 1=VCC 2=GND
```

Pins you don't list are left unconnected. JSON works too:
`{"board":{"strips":20,"holes":30},"components":[{"ref":"R1","footprint":"axial(4-8)","value":"1k","pins":{"1":"VCC","2":"DIS"}}]}`

## Development

```bash
npm test
```

```bash
npm run build
```

```bash
npm run bench
```

```bash
npx vite preview --port 4173 &
npm run e2e
```

- `npm test` runs the unit tests: parser, footprints, router, verifier, a router-vs-verifier property test, and annealing on every example.
- `npm run build` typechecks and builds into `dist/`.
- `npm run bench` reports layout quality and speed for each example.
- `npm run e2e` drives the built app with Playwright and saves screenshots to `screenshots/`.

Code layout:
- `src/core`: the engine, pure TypeScript with no DOM.
- `src/worker`: the Web Worker wrapper.
- `src/ui`: the React app.
- `src/examples`: the built-in circuits.
