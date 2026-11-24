# Stripboard Optimiser

A browser app that turns a netlist into a buildable **stripboard (Veroboard) layout**. It chooses component positions and orientations, then works out the **track cuts** and **wire links**, so you get a layout you can solder from a printed build sheet.

It also lays out **perfboard** (an isolated pad per hole), wiring it with solder-side traces, jumper wires, or point-to-point insulated wire. See [Perfboard](#perfboard).

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

## Exact solver (clingo, as in the paper)

The **Exact solver** panel runs [clingo](https://potassco.org/) in the browser via
[clingo-wasm](https://www.npmjs.com/package/clingo-wasm). The encoding is in `src/asp/encode.ts`. For each footprint variant (a rotation plus a lead span), the encoding emits the shape once. Clingo then generates the candidate positions itself, which keeps the program small.

**Paper model.** This follows the paper's rules, applied to real footprints:
- each net sits on one strip
- pins 1 and 2 of a part are on different strips
- the objective is TD@3, then area@2, then width@1

Some circuits break these rules no matter where parts go: for example, two same-net pins of a DIP that can never share a strip. The app reports those immediately, without running the solver.

**Relaxed model.** Nets may span several strips. The objective is (link weight × strips used per net) + area. After solving, the router adds the cuts and links.

Findings on the built-in examples:
- **With real footprints, the paper's model is almost never satisfiable.**
  - The 555, TL072 and LM386 circuits are inexpressible because of their IC pinouts.
  - Clingo proves even the LED + resistor circuit and the transistor astable unsatisfiable. A resistor lying flat must span 4 or more strips, which conflicts with the strips its neighbouring parts force.
  - The LED circuit becomes feasible with a standing resistor (`axial(1-6)`).
- **Relaxed ASP packs parts much tighter than annealing** (555: 9×11 vs 9×14). But it cannot see link routing, so the router usually cannot finish its layouts.
- **Annealing produced the buildable layouts.** Its cost function runs the full router on every move.
- **"Refine current" can start from an ASP placement.** Starting the annealer from it sometimes beats annealing from scratch: on the astable, the cost went from 146 to 120.
- **clingo-wasm ignores `--time-limit`.** The app enforces the limit itself in JavaScript and keeps the best model streamed so far.
- **The `.lp` button** downloads the exact program, so you can run it with native clingo.

### Full model: placement, cuts and links in ASP (beyond the paper)

The **Full** model (the panel's default) treats the whole layout as one ASP problem. Clingo chooses where every part goes, every track cut and every wire link together.

- **Copper and cuts:** neighbouring holes on a strip are connected unless clingo places a cut there.
- **Links:** they are vertical, at most `maxlink` strips long, and never pass over pins, bodies or other links.
- **Correctness by construction.** Each net has a root pin, and connectivity spreads from it through copper and links (`reach/3`). Two rules then hold:
  - every pin of a net must be reached
  - no hole may be reached by two nets

  So any answer clingo returns is a complete, buildable layout. Answers are still passed through `verify()`.
- **Bus strips come free.** Nets can route through otherwise empty strips; the annealer's router can't do this.
- **The objective is the annealer's weighted cost**, scaled to integers.
- **Symmetry breaking:**
  - Each cut must sit directly right of a used hole. Every layout has one equivalent in this form.
  - The layout is anchored at the corner of the board.

  For display and the build sheet, cuts are moved back to the middle of their gap (`centreCuts`).

Solving a whole board from scratch is too hard for clingo beyond tiny circuits; it found no model for the 555 in 30 s. So **Improve with clingo** does large-neighbourhood search starting from the layout on screen:
- It frees 2–8 nearby parts, plus all cuts and links within 2 holes of them. Everything else stays fixed.
- The annealer's solution is supplied as a warm start through `#heuristic`.
- Clingo solves each window exactly, within 3 s, and an improvement is kept only if it passes `verify()`.
- The window size adapts: it grows when windows are solved to optimality quickly and shrinks when they time out.
- If one window covers every part and the whole board and is solved to optimality, the layout is **proven optimal**.

Results after annealing (60k iterations × 3 restarts), then 30 s of clingo windows (`BENCH=1 FULL=1 npm run bench`):

| Circuit | Annealing | + clingo windows | Change |
|---|---|---|---|
| LED + resistor | 16 | 16 | **proven optimal** in 0.2 s |
| 555 flasher | 178 | 167 | −1 cut, −1 link, shorter links |
| Transistor astable | 146 | 144 | shorter links |
| TL072 filter | 264 | 255 | −1 cut, −1 link |
| LM386 amplifier | 219 | 204 | −2 cuts, −2 links |

## Perfboard

Choose **Perfboard** under Settings. Every hole is then an isolated pad: nothing is connected until you wire it, and there are no track cuts. You choose which kinds of wiring the optimiser may use:

- **Solder-side traces** (on by default): runs of solder bridges or bare tinned wire along the hole grid.
  - Traces only go horizontally or vertically from hole to hole, and every hole they pass is soldered.
  - So traces of different nets can never cross or share a hole.
  - They may pass under a part's body, but not through another net's pin.
- **Jumper wires**, one of:
  - **None.**
  - **Straight** (default): bare wire on the component side, horizontal or vertical, ending in free holes next to the traces. Like stripboard links, they can't pass over pins, bodies or other jumpers.
  - **Any angle**: insulated wire between any two holes, ending on a pad or trace of its net. These may cross anything. With traces switched off, this is classic **point-to-point** wiring, pad to pad.
- **Longest jumper** caps jumper length (in holes, straight-line for angled wires).

On perfboard, DIPs may also turn 90°, because there are no strips to short their pin rows.

**Router** (`src/core/perfroute.ts`). Nets are routed shortest first. Each net grows a tree from one pin and joins its nearest unconnected pin with the cheapest of:
- an A* trace path. Bends and holes outside the parts' bounding box cost a little extra, so traces stay tidy and the board stays small.
- if the pin can't be reached by traces, or only by a long detour, a route that also uses straight jumpers.
- an angled jumper straight to the pin.

Pins that can't be reached are reported as unrouted, so the annealer's penalty steers placement away from them. Costs come from the same weights as the annealer's: **Trace (per hole step)**, **Jumper wire** and **Jumper length**.

**Verifier.** `verifyPerfboard` checks the result independently:
- It treats holes as union-find nodes. Each trace joins every hole along it, and each jumper joins its two ends.
- It compares the connectivity with the netlist: no shorts, no opens.
- It also checks the physical rules of the chosen options.

The clingo panel applies to stripboard only and is hidden on perfboard.

Annealing defaults to 20k iterations on perfboard, because routing is a maze search. To compare the wiring options on every example, run `BENCH=1 PERF=1 ITERS=20000 npm run bench`.

## Using it

```bash
npm install
```

```bash
npm run dev
```

Pick an example or type a netlist, choose **Stripboard** or **Perfboard** under Settings, then press **Optimise**. Drag parts to adjust the layout by hand: <kbd>R</kbd> rotates, <kbd>[</kbd>/<kbd>]</kbd> changes the lead span, and the arrow keys nudge. **Refine current** anneals gently, starting from your edits. Use **Copper side** to see the mirrored view you will cut from. Export as SVG/PNG, a text build sheet, or a JSON project.

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

- `npm test` runs the unit tests: parser, footprints, router, verifier, a router-vs-verifier property test, and annealing on every example, for stripboard and for perfboard (each wiring option).
- `npm run build` typechecks and builds into `dist/`.
- `npm run bench` reports layout quality and speed for each example.
- `npm run e2e` drives the built app with Playwright (including the clingo solver and perfboard mode) and saves screenshots to `screenshots/`.
- `BENCH=1 ASP=1 npm run bench` adds the comparison of ASP (relaxed) + router vs annealing.
- `BENCH=1 FULL=1 npm run bench` runs annealing followed by clingo window search (full model).
- `BENCH=1 PERF=1 npm run bench` anneals every example on perfboard under each wiring option (`ITERS`, `RESTARTS`, `EX`, `VAR` narrow it).

Code layout:
- `src/core`: the engine, pure TypeScript with no DOM. `route.ts` is the stripboard router and `perfroute.ts` the perfboard router; `verify.ts` has a verifier for each.
- `src/asp`: the ASP encoding and the clingo-wasm wrapper.
- `src/worker`: the Web Worker wrapper.
- `src/ui`: the React app.
- `src/examples`: the built-in circuits.
