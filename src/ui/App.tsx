import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomLayout, type AnnealStatus } from '../core/anneal';
import { evaluate, isClean } from '../core/cost';
import { clampToBoard, FOOTPRINT_HELP, geometry } from '../core/footprints';
import { parseNetlist } from '../core/netlist/parse';
import { autoBoardSize, makeProblem } from '../core/problem';
import { Rng } from '../core/rng';
import { DEFAULT_WEIGHTS, type BoardSize, type CostWeights, type CutMode, type Layout, type Netlist, type Placement } from '../core/types';
import { verify } from '../core/verify';
import { EXAMPLES } from '../examples';
import type { StartMessage, WorkerMessage } from '../worker/protocol';
import { BoardView, type Side } from './BoardView';
import { buildSheet, buildSheetText } from './buildSheet';
import { downloadBlob, downloadText, svgToPng, svgToString } from './download';
import { Sparkline } from './Sparkline';

const STORAGE_KEY = 'stripboard-optimiser-v1';

interface Settings {
  iterations: number;
  restarts: number;
  seed: number;
  cutMode: CutMode;
  boardMode: 'auto' | 'custom';
  customBoard: BoardSize;
  weights: CostWeights;
}

const DEFAULT_SETTINGS: Settings = {
  iterations: 60000,
  restarts: 3,
  seed: 1,
  cutMode: 'hole',
  boardMode: 'auto',
  customBoard: { strips: 20, holes: 30 },
  weights: DEFAULT_WEIGHTS,
};

interface Saved {
  source: string;
  placements: Record<string, Placement>;
  settings: Settings;
}

function loadSaved(): Saved | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Saved;
    if (typeof s.source !== 'string') return null;
    return { ...s, settings: { ...DEFAULT_SETTINGS, ...s.settings, weights: { ...DEFAULT_WEIGHTS, ...s.settings?.weights } } };
  } catch {
    return null;
  }
}

const WEIGHT_LABELS: [keyof CostWeights, string][] = [
  ['area', 'Board area (per hole)'],
  ['cut', 'Track cut'],
  ['link', 'Wire link'],
  ['linkLength', 'Link length (per strip)'],
  ['paperTD', 'Paper TD (per strip)'],
  ['unrouted', 'Unrouted connection'],
  ['short', 'Short'],
  ['overlap', 'Overlap'],
];

export function App() {
  const saved = useMemo(loadSaved, []);
  const [source, setSource] = useState(saved?.source ?? EXAMPLES[1].source);
  const [settings, setSettings] = useState<Settings>(saved?.settings ?? DEFAULT_SETTINGS);
  const [placements, setPlacements] = useState<Record<string, Placement>>(saved?.placements ?? {});
  const [side, setSide] = useState<Side>('component');
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [selected, setSelected] = useState<number | null>(null);
  const [hoverNet, setHoverNet] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<AnnealStatus | null>(null);
  const [history, setHistory] = useState<{ p: number; best: number; current: number }[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [runId, setRunId] = useState(0);
  const autoRun = useRef(!saved);
  const workersRef = useRef<Worker[]>([]);
  const [workerCount, setWorkerCount] = useState(1);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // --- netlist ---------------------------------------------------------------
  const parsed = useMemo(() => parseNetlist(source), [source]);
  const [netlist, setNetlist] = useState<Netlist | null>(parsed.netlist);
  useEffect(() => {
    if (parsed.netlist) setNetlist(parsed.netlist);
  }, [parsed]);

  const board: BoardSize | null = useMemo(() => {
    if (!netlist) return null;
    if (settings.boardMode === 'custom') return settings.customBoard;
    return netlist.board ?? autoBoardSize(netlist);
  }, [netlist, settings.boardMode, settings.customBoard]);

  const problem = useMemo(() => (netlist && board ? makeProblem(netlist, board) : null), [netlist, board]);

  // Layout = saved placement per ref when still valid, else a deterministic random spot.
  const layout: Layout | null = useMemo(() => {
    if (!problem) return null;
    const fallback = randomLayout(problem, new Rng(settings.seed));
    return problem.netlist.components.map((c, i) => {
      const fp = problem.fps[i];
      const p = placements[c.ref];
      if (p && fp.rotations.includes(p.rot) && fp.spans.includes(p.span)) {
        return clampToBoard(fp, p, problem.board.holes, problem.board.strips);
      }
      return fallback[i];
    });
  }, [problem, placements, settings.seed]);

  const routeOpts = useMemo(() => ({ cutMode: settings.cutMode }), [settings.cutMode]);
  const evaluation = useMemo(
    () => (problem && layout ? evaluate(problem, layout, routeOpts, settings.weights) : null),
    [problem, layout, routeOpts, settings.weights],
  );
  const verification = useMemo(
    () => (problem && layout && evaluation ? verify(problem, layout, evaluation.route.cuts, evaluation.route.links) : null),
    [problem, layout, evaluation],
  );

  // --- persistence -------------------------------------------------------------
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ source, placements, settings } satisfies Saved));
      } catch {
        /* storage unavailable: fine */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [source, placements, settings]);

  // --- optimiser ---------------------------------------------------------------
  const stop = useCallback(() => {
    workersRef.current.forEach((w) => w.terminate());
    workersRef.current = [];
    setRunning(false);
  }, []);

  const applyLayout = useCallback((refs: string[], l: Layout) => {
    setPlacements((prev) => {
      const next = { ...prev };
      refs.forEach((r, i) => (next[r] = l[i]));
      return next;
    });
  }, []);

  /**
   * Run the annealer. Restarts are spread over several Web Workers (one per spare CPU core)
   * with different seeds; the best layout found by any of them is shown live.
   */
  const run = useCallback(
    (fromCurrent: boolean) => {
      if (!problem || !layout) return;
      stop();
      const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
      const n = fromCurrent ? 1 : Math.max(1, Math.min(settings.restarts, 8, cores - 1));
      const per = Math.ceil((fromCurrent ? 1 : settings.restarts) / n);
      const refs = problem.netlist.components.map((c) => c.ref);
      const t0 = performance.now();
      const st = Array.from({ length: n }, () => ({ progress: 0, best: Infinity, current: Infinity, done: false, restart: 0 }));
      let globalBest = Infinity;
      setRunning(true);
      setRunId((k) => k + 1);
      setStatus(null);
      setRunError(null);
      setHistory([]);
      setElapsed(null);
      setSelected(null);

      const workers: Worker[] = [];
      for (let k = 0; k < n; k++) {
        const worker = new Worker(new URL('../worker/optimizer.worker.ts', import.meta.url), { type: 'module' });
        workers.push(worker);
        worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
          if (!workersRef.current.includes(worker)) return;
          const m = e.data;
          if (m.type === 'error') {
            setRunError(m.message);
            stop();
            return;
          }
          st[k] = { progress: m.status.progress, best: m.status.bestCost, current: m.status.currentCost, done: m.type === 'done', restart: m.status.restart };
          if (m.best && m.best.cost < globalBest) {
            globalBest = m.best.cost;
            applyLayout(refs, m.best.layout);
          }
          const progress = st.reduce((a, s) => a + s.progress, 0) / n;
          const best = Math.min(...st.map((s) => s.best));
          const current = Math.min(...st.map((s) => s.current));
          const allDone = st.every((s) => s.done);
          setStatus({ ...m.status, progress: allDone ? 1 : progress, bestCost: best, currentCost: current, done: allDone, restart: Math.max(...st.map((s) => s.restart)) });
          setHistory((h) => [...h, { p: progress, best, current }]);
          if (m.type === 'done') worker.terminate();
          if (allDone) {
            setElapsed((performance.now() - t0) / 1000);
            workersRef.current = [];
            setRunning(false);
          }
        };
        worker.onerror = (e) => {
          setRunError(e.message || 'optimiser crashed');
          stop();
        };
        const msg: StartMessage = {
          type: 'start',
          netlist: problem.netlist,
          board: problem.board,
          iterations: settings.iterations,
          restarts: per,
          seed: settings.seed * 7919 + k,
          weights: settings.weights,
          route: routeOpts,
          initial: fromCurrent ? layout : undefined,
        };
        worker.postMessage(msg);
      }
      workersRef.current = workers;
      setWorkerCount(n);
    },
    [problem, layout, settings, routeOpts, stop, applyLayout],
  );

  // Stop when the problem changes under a running optimiser; auto-run after loading an example.
  useEffect(() => {
    if (workersRef.current.length) stop();
    if (autoRun.current && problem) {
      autoRun.current = false;
      run(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problem]);

  useEffect(() => () => workersRef.current.forEach((w) => w.terminate()), []);

  // --- manual editing ------------------------------------------------------------
  const movePart = useCallback(
    (i: number, p: Placement) => {
      if (!problem) return;
      const fp = problem.fps[i];
      const clamped = clampToBoard(fp, p, problem.board.holes, problem.board.strips);
      setPlacements((prev) => ({ ...prev, [problem.netlist.components[i].ref]: clamped }));
    },
    [problem],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (selected === null || !problem || !layout || running) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
      const fp = problem.fps[selected];
      const p = layout[selected];
      let next: Placement | null = null;
      switch (e.key) {
        case 'r':
        case 'R': {
          const rots = fp.rotations;
          const rot = rots[(rots.indexOf(p.rot) + (e.shiftKey ? rots.length - 1 : 1)) % rots.length];
          const g0 = geometry(fp, p.rot, p.span);
          const g1 = geometry(fp, rot, p.span);
          next = { ...p, rot, x: p.x + Math.round((g0.w - g1.w) / 2), y: p.y + Math.round((g0.h - g1.h) / 2) };
          break;
        }
        case '[':
        case ']': {
          const idx = fp.spans.indexOf(p.span) + (e.key === ']' ? 1 : -1);
          if (idx >= 0 && idx < fp.spans.length) next = { ...p, span: fp.spans[idx] };
          break;
        }
        case 'ArrowLeft':
          next = { ...p, x: p.x - 1 };
          break;
        case 'ArrowRight':
          next = { ...p, x: p.x + 1 };
          break;
        case 'ArrowUp':
          next = { ...p, y: p.y - 1 };
          break;
        case 'ArrowDown':
          next = { ...p, y: p.y + 1 };
          break;
        case 'Escape':
          setSelected(null);
          return;
        default:
          return;
      }
      e.preventDefault();
      if (next) movePart(selected, next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, problem, layout, running, movePart]);

  // --- examples, import / export ---------------------------------------------------
  const loadExample = (id: string) => {
    const ex = EXAMPLES.find((e) => e.id === id);
    if (!ex) return;
    stop();
    setPlacements({});
    setSelected(null);
    setSettings((s) => ({ ...s, boardMode: 'auto' }));
    autoRun.current = true;
    setSource(ex.source);
  };

  const sheet = useMemo(
    () => (problem && layout && evaluation ? buildSheet(problem, layout, evaluation.route, evaluation.metrics) : null),
    [problem, layout, evaluation],
  );

  const exportSvg = () => svgRef.current && downloadText(svgToString(svgRef.current), `stripboard-${side}.svg`, 'image/svg+xml');
  const exportPng = async () => svgRef.current && downloadBlob(await svgToPng(svgRef.current), `stripboard-${side}.png`);
  const exportSheet = () => sheet && downloadText(buildSheetText(sheet), 'stripboard-build-sheet.txt');
  const saveProject = () =>
    downloadText(JSON.stringify({ format: 'stripboard-project', version: 1, source, placements, settings }, null, 2), 'stripboard-project.json', 'application/json');
  const loadProject = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      if (data?.format !== 'stripboard-project' || typeof data.source !== 'string') throw new Error('not a stripboard project file');
      stop();
      setSource(data.source);
      setPlacements(data.placements ?? {});
      setSettings({ ...DEFAULT_SETTINGS, ...data.settings, weights: { ...DEFAULT_WEIGHTS, ...data.settings?.weights } });
    } catch (e) {
      alert(`Could not load project: ${(e as Error).message}`);
    }
  };

  const setWeight = (k: keyof CostWeights, v: number) => setSettings((s) => ({ ...s, weights: { ...s.weights, [k]: v } }));

  const m = evaluation?.metrics;
  const clean = m ? isClean(m) && verification?.ok : false;
  const sel = selected !== null && problem && layout ? { c: problem.netlist.components[selected], fp: problem.fps[selected], p: layout[selected] } : null;
  const staleNetlist = parsed.netlist === null;

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          <span className="logo" aria-hidden="true">▤</span> Stripboard Optimiser
        </h1>
        <p className="tagline">Automatic component placement, track cuts and wire links for stripboard / Veroboard</p>
      </header>

      <aside className="panel left">
        <section>
          <div className="row between">
            <h2>Circuit</h2>
            <select aria-label="Load example" value="" onChange={(e) => loadExample(e.target.value)}>
              <option value="" disabled>
                Load example…
              </option>
              {EXAMPLES.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
          <textarea
            className="netlist"
            spellCheck={false}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            aria-label="Netlist"
          />
          {parsed.errors.length > 0 && (
            <ul className="messages errors">
              {parsed.errors.map((e, i) => (
                <li key={i}>
                  Line {e.line}: {e.message}
                </li>
              ))}
            </ul>
          )}
          {parsed.warnings.length > 0 && (
            <ul className="messages warnings">
              {parsed.warnings.map((e, i) => (
                <li key={i}>
                  Line {e.line}: {e.message}
                </li>
              ))}
            </ul>
          )}
          {staleNetlist && netlist && <p className="hint">Showing the last valid netlist until the errors are fixed.</p>}
        </section>
        <details className="help">
          <summary>Netlist format & footprints</summary>
          <p>
            One part per line: <code>REF FOOTPRINT [VALUE] pin=NET …</code>. Unlisted pins are unconnected. Optional{' '}
            <code>board 20x30</code> (strips × holes). <code>#</code> starts a comment. JSON is accepted too.
          </p>
          <table>
            <tbody>
              {FOOTPRINT_HELP.map((f) => (
                <tr key={f.spec}>
                  <td>
                    <code>{f.spec}</code>
                  </td>
                  <td>{f.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </aside>

      <main className="center">
        <div className="toolbar">
          <div className="seg" role="group" aria-label="Board side">
            <button className={side === 'component' ? 'on' : ''} onClick={() => setSide('component')}>
              Component side
            </button>
            <button className={side === 'copper' ? 'on' : ''} onClick={() => setSide('copper')}>
              Copper side
            </button>
          </div>
          <div className="seg" role="group" aria-label="Zoom">
            <button className={zoom === 'fit' ? 'on' : ''} onClick={() => setZoom('fit')}>
              Fit
            </button>
            <button className={zoom === 1 ? 'on' : ''} onClick={() => setZoom(1)}>
              100%
            </button>
            <button className={zoom === 1.6 ? 'on' : ''} onClick={() => setZoom(1.6)}>
              160%
            </button>
          </div>
          <div className="spacer" />
          <button onClick={exportSvg}>SVG</button>
          <button onClick={exportPng}>PNG</button>
          <button onClick={exportSheet}>Build sheet</button>
          <button onClick={saveProject}>Save</button>
          <button onClick={() => fileRef.current?.click()}>Open…</button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) loadProject(f);
              e.target.value = '';
            }}
          />
        </div>

        <div className={`board-wrap zoom-${zoom === 'fit' ? 'fit' : 'fixed'}`}>
          {problem && layout && evaluation ? (
            <div style={zoom === 'fit' ? undefined : { width: (problem.board.holes * 22 + 56) * zoom }}>
              <BoardView
                problem={problem}
                layout={layout}
                route={evaluation.route}
                side={side}
                selected={selected}
                hoverNet={hoverNet}
                editable={!running}
                onSelect={setSelected}
                onHoverNet={setHoverNet}
                onMove={movePart}
                svgRef={svgRef}
                used={evaluation.metrics.bbox}
              />
            </div>
          ) : (
            <p className="hint">Enter a netlist to begin.</p>
          )}
        </div>

        <div className="statusbar">
          {sel ? (
            <span>
              <b>{sel.c.ref}</b> {sel.c.value} <code>{sel.fp.name}</code> · {sel.p.rot}° · span {sel.p.span} — drag to move, <kbd>R</kbd> rotate
              {sel.fp.spans.length > 1 && (
                <>
                  , <kbd>[</kbd>/<kbd>]</kbd> span
                </>
              )}
              , arrows nudge
            </span>
          ) : hoverNet ? (
            <span>
              Net <b>{hoverNet}</b>
            </span>
          ) : (
            <span className="hint">Click a part to select it; drag to move. Hover copper to highlight a net.</span>
          )}
        </div>

        {sheet && (
          <details className="sheet">
            <summary>
              Build sheet — {sheet.cuts.length} cuts, {sheet.links.length} links, {sheet.parts.length} parts
            </summary>
            <p>
              <b>Board:</b> {sheet.board}
            </p>
            <div className="sheet-cols">
              <div>
                <h3>Track cuts (copper side)</h3>
                <ol>
                  {sheet.cuts.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ol>
              </div>
              <div>
                <h3>Wire links</h3>
                <ol>
                  {sheet.links.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ol>
              </div>
            </div>
            <h3>Components</h3>
            <table className="parts">
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>Value</th>
                  <th>Footprint</th>
                  <th>Pins</th>
                </tr>
              </thead>
              <tbody>
                {sheet.parts.map((p) => (
                  <tr key={p.ref}>
                    <td>{p.ref}</td>
                    <td>{p.value}</td>
                    <td>
                      <code>{p.footprint}</code>
                    </td>
                    <td className="mono">{p.pins}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </main>

      <aside className="panel right">
        <section>
          <h2>Optimiser</h2>
          <div className="row">
            {running ? (
              <button className="primary" onClick={stop}>
                Stop
              </button>
            ) : (
              <>
                <button className="primary" onClick={() => run(false)} disabled={!problem}>
                  Optimise
                </button>
                <button onClick={() => run(true)} disabled={!problem} title="Anneal gently starting from the current layout">
                  Refine current
                </button>
              </>
            )}
          </div>
          {(running || status) && (
            <div className="progress" data-run={runId} data-done={!running && elapsed !== null ? 'yes' : 'no'}>
              <div className="bar">
                <div style={{ width: `${((status?.progress ?? 0) * 100).toFixed(1)}%` }} />
              </div>
              <div className="row between small">
                <span>
                  {running
                    ? `Annealing on ${workerCount} thread${workerCount > 1 ? 's' : ''}…`
                    : elapsed !== null
                      ? `Done in ${elapsed.toFixed(1)} s`
                      : 'Stopped'}
                </span>
                <span>best {Number.isFinite(status?.bestCost) ? status!.bestCost.toFixed(1) : '–'}</span>
              </div>
              <Sparkline points={history} />
            </div>
          )}
          {runError && <p className="messages errors">{runError}</p>}
        </section>

        <section>
          <h2>Result</h2>
          {m && verification ? (
            <>
              <div className={`badge ${clean ? 'ok' : 'bad'}`} data-testid="verify-status">
                {clean ? 'Verified ✓' : 'Not buildable yet ✗'}
              </div>
              {!clean && (
                <ul className="messages errors">
                  {evaluation!.route.violations.slice(0, 6).map((v, i) => (
                    <li key={`v${i}`}>{v.message}</li>
                  ))}
                  {m.unrouted > 0 && <li>{m.unrouted} unrouted connection(s) (dashed red lines)</li>}
                  {verification.errors.slice(0, 4).map((e, i) => (
                    <li key={`e${i}`}>{e}</li>
                  ))}
                </ul>
              )}
              <table className="metrics">
                <tbody>
                  <tr>
                    <td>Board used</td>
                    <td>
                      {m.height} strips × {m.width} holes ({m.area})
                    </td>
                  </tr>
                  <tr>
                    <td>Track cuts</td>
                    <td>{m.cuts}</td>
                  </tr>
                  <tr>
                    <td>Wire links</td>
                    <td>
                      {m.links} (total {m.linkLength} strips)
                    </td>
                  </tr>
                  <tr>
                    <td>Unrouted</td>
                    <td>{m.unrouted}</td>
                  </tr>
                  <tr>
                    <td title="Paper metric (arXiv:2512.04910): Σ |strip(pin 1) − strip(pin 2)| per part">Paper TD</td>
                    <td>{m.paperTD}</td>
                  </tr>
                  <tr>
                    <td>Cost</td>
                    <td>{evaluation!.cost.toFixed(1)}</td>
                  </tr>
                </tbody>
              </table>
            </>
          ) : (
            <p className="hint">No layout yet.</p>
          )}
        </section>

        <section>
          <h2>Settings</h2>
          <label className="field">
            <span>Board</span>
            <select
              value={settings.boardMode}
              onChange={(e) => setSettings((s) => ({ ...s, boardMode: e.target.value as Settings['boardMode'], customBoard: board ?? s.customBoard }))}
            >
              <option value="auto">Auto{board && settings.boardMode === 'auto' ? ` (${board.strips}×${board.holes})` : ''}</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          {settings.boardMode === 'custom' && (
            <div className="row">
              <label className="field">
                <span>Strips</span>
                <input
                  type="number"
                  min={3}
                  max={100}
                  value={settings.customBoard.strips}
                  onChange={(e) => setSettings((s) => ({ ...s, customBoard: { ...s.customBoard, strips: Math.max(3, Math.min(100, +e.target.value || 3)) } }))}
                />
              </label>
              <label className="field">
                <span>Holes</span>
                <input
                  type="number"
                  min={3}
                  max={100}
                  value={settings.customBoard.holes}
                  onChange={(e) => setSettings((s) => ({ ...s, customBoard: { ...s.customBoard, holes: Math.max(3, Math.min(100, +e.target.value || 3)) } }))}
                />
              </label>
            </div>
          )}
          <label className="field">
            <span>Track cuts</span>
            <select value={settings.cutMode} onChange={(e) => setSettings((s) => ({ ...s, cutMode: e.target.value as CutMode }))}>
              <option value="hole">At a hole (spot-face cutter)</option>
              <option value="between">Between holes (knife)</option>
            </select>
          </label>
          <div className="row">
            <label className="field">
              <span>Iterations</span>
              <input
                type="number"
                min={1000}
                step={10000}
                value={settings.iterations}
                onChange={(e) => setSettings((s) => ({ ...s, iterations: Math.max(1000, +e.target.value || 1000) }))}
              />
            </label>
            <label className="field">
              <span>Restarts</span>
              <input
                type="number"
                min={1}
                max={20}
                value={settings.restarts}
                onChange={(e) => setSettings((s) => ({ ...s, restarts: Math.max(1, Math.min(20, +e.target.value || 1)) }))}
              />
            </label>
            <label className="field">
              <span>Seed</span>
              <input type="number" value={settings.seed} onChange={(e) => setSettings((s) => ({ ...s, seed: Math.trunc(+e.target.value) || 1 }))} />
            </label>
          </div>
          <details>
            <summary>Cost weights</summary>
            {WEIGHT_LABELS.map(([k, label]) => (
              <label className="field inline" key={k}>
                <span>{label}</span>
                <input type="number" min={0} step="any" value={settings.weights[k]} onChange={(e) => setWeight(k, Math.max(0, +e.target.value || 0))} />
              </label>
            ))}
            <button onClick={() => setSettings((s) => ({ ...s, weights: DEFAULT_WEIGHTS }))}>Reset weights</button>
          </details>
        </section>
      </aside>
    </div>
  );
}
