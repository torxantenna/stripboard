import { useRef, useState } from 'react';
import { centreCuts, compactBoard, encode, type AspMode } from '../asp/encode';
import { abortAsp, polishWithClingo, scoreSolution, solveAsp, type AspResult } from '../asp/solve';
import { evaluate, isClean } from '../core/cost';
import { makeProblem, type Problem } from '../core/problem';
import type { CostWeights, Cut, CutMode, Layout, Link, Metrics } from '../core/types';
import { verify } from '../core/verify';
import { downloadText } from './download';

export interface Snapshot {
  layout: Layout;
  /** Present when clingo chose the cuts and links itself (full model). */
  solution?: { cuts: Cut[]; links: Link[] };
  metrics: Metrics;
  clean: boolean;
  seconds: number;
}

interface Props {
  problem: Problem;
  currentMetrics: Metrics | null;
  cutMode: CutMode;
  weights: CostWeights;
  sa: Snapshot | null;
  /** The layout on screen, with its cuts and links, and whether it verifies. */
  current: { layout: Layout; cuts: Cut[]; links: Link[]; ok: boolean } | null;
  disabled: boolean;
  onShow: (layout: Layout, solution?: { cuts: Cut[]; links: Link[] }) => void;
}

interface FullRun {
  windows: number;
  improvements: number;
  startCost: number;
  cost: number;
  seconds: number;
  provenOptimal: boolean;
  snap: Snapshot;
}

const OUTCOME_TEXT: Record<AspResult['outcome'], string> = {
  optimum: 'Optimum found',
  timeout: 'Time limit — best model so far',
  unsat: 'Unsatisfiable',
  'infeasible-model': 'Not expressible in the paper model',
  error: 'Error',
  unknown: 'No model found in time',
};

/** Exact placement with clingo (Answer Set Programming), for comparison with the paper and the annealer. */
export function AspPanel({ problem, currentMetrics, cutMode, weights, sa, current, disabled, onShow }: Props) {
  const [mode, setMode] = useState<AspMode>('full');
  const [boardMode, setBoardMode] = useState<'compact' | 'full'>('compact');
  const [timeLimit, setTimeLimit] = useState(20);
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<{ models: number; seconds: number; costs: number[] } | null>(null);
  const [result, setResult] = useState<(AspResult & { snap: Snapshot | null }) | null>(null);
  const [full, setFull] = useState<FullRun | null>(null);
  const [fullLive, setFullLive] = useState<{ windows: number; improvements: number; cost: number; seconds: number } | null>(null);
  const [fullError, setFullError] = useState<string | null>(null);
  const stopRef = useRef(false);

  const board = () =>
    boardMode === 'compact' && currentMetrics ? compactBoard(currentMetrics, problem.board, 2) : problem.board;

  const snapOf = (layout: Layout, seconds: number): Snapshot => {
    const ev = evaluate(problem, layout, { cutMode }, weights);
    const v = verify(problem, layout, ev.route.cuts, ev.route.links);
    return { layout, metrics: ev.metrics, clean: isClean(ev.metrics) && v.ok, seconds };
  };

  /** Clingo puts cuts right next to a used hole; centre them in their gap for building. */
  const tidy = (layout: Layout, cuts: Cut[], links: Link[]) => centreCuts(problem, layout, cuts, links, cutMode, problem.board.holes);

  /** Full model: improve the layout on screen window by window (large-neighbourhood search). */
  const improve = async () => {
    setFull(null);
    setFullError(null);
    setFullLive(null);
    if (!current || !current.ok) {
      setFullError('Run the optimiser first: clingo improves a complete, verified layout window by window.');
      return;
    }
    setRunning(true);
    stopRef.current = false;
    try {
      const b = board();
      const p = makeProblem(problem.netlist, b);
      const startCost = scoreSolution(problem, current.layout, current.cuts, current.links, weights).cost;
      const r = await polishWithClingo(
        p,
        { layout: current.layout, cuts: current.cuts, links: current.links },
        { cutMode, weights, timeLimit },
        (pr) => {
          setFullLive({ windows: pr.windows, improvements: pr.improvements, cost: pr.best.cost, seconds: pr.seconds });
          onShow(pr.best.layout, { cuts: tidy(pr.best.layout, pr.best.cuts, pr.best.links), links: pr.best.links });
        },
        () => stopRef.current,
      );
      const best = scoreSolution(problem, r.best.layout, tidy(r.best.layout, r.best.cuts, r.best.links), r.best.links, weights);
      onShow(best.layout, { cuts: best.cuts, links: best.links });
      setFull({
        windows: r.windows,
        improvements: r.improvements,
        startCost,
        cost: best.cost,
        seconds: r.seconds,
        provenOptimal: r.provenOptimal,
        snap: { layout: best.layout, solution: { cuts: best.cuts, links: best.links }, metrics: best.metrics, clean: best.ok && isClean(best.metrics), seconds: r.seconds },
      });
    } catch (e) {
      setFullError(String((e as Error)?.message ?? e));
    } finally {
      setRunning(false);
    }
  };

  const solve = async () => {
    if (mode === 'full') return improve();
    setRunning(true);
    setLive(null);
    setResult(null);
    try {
      const b = board();
      const p = makeProblem(problem.netlist, b);
      const r = await solveAsp(p, { mode, board: b, cutMode, timeLimit, linkWeight: Math.round(weights.link + weights.linkLength) }, (pr) => {
        setLive({ models: pr.models, seconds: pr.seconds, costs: pr.costs });
        onShow(pr.layout);
      });
      const snap = r.layout ? snapOf(r.layout, r.seconds) : null;
      if (r.layout) onShow(r.layout);
      setResult({ ...r, snap });
    } finally {
      setRunning(false);
    }
  };

  const stop = async () => {
    stopRef.current = true;
    await abortAsp();
  };

  const downloadLp = () => {
    const b = board();
    const enc = encode(makeProblem(problem.netlist, b), {
      mode,
      board: b,
      cutMode,
      weights,
      linkWeight: Math.round(weights.link + weights.linkLength),
      hint: mode === 'full' && current ? current : undefined,
    });
    downloadText(enc.program, `stripboard-${mode}.lp`);
  };

  const asp = mode === 'full' ? (full?.snap ?? null) : (result?.snap ?? null);
  const row = (label: string, f: (s: Snapshot) => string) => (
    <tr>
      <td>{label}</td>
      <td>{sa ? f(sa) : '–'}</td>
      <td>{asp ? f(asp) : '–'}</td>
    </tr>
  );

  return (
    <section className="asp">
      <h2>Exact solver (clingo)</h2>
      <p className="small">
        Answer Set Programming, as in{' '}
        <a href="https://arxiv.org/html/2512.04910v1" target="_blank" rel="noreferrer">
          arXiv:2512.04910
        </a>
        , running in your browser via WebAssembly.
      </p>
      <label className="field">
        <span>Model</span>
        <select value={mode} onChange={(e) => setMode(e.target.value as AspMode)} disabled={running}>
          <option value="full">Full: placement + cuts + links, improves current layout</option>
          <option value="paper">Paper: one strip per net, TD › area › width</option>
          <option value="relaxed">Relaxed: fewest strips per net + area, router adds links</option>
        </select>
      </label>
      <div className="row">
        <label className="field">
          <span>Board</span>
          <select value={boardMode} onChange={(e) => setBoardMode(e.target.value as 'compact' | 'full')} disabled={running}>
            <option value="compact">Compact (current used area + 2)</option>
            <option value="full">Full optimiser board</option>
          </select>
        </label>
        <label className="field" style={{ maxWidth: 80 }}>
          <span>Limit (s)</span>
          <input type="number" min={1} max={600} value={timeLimit} onChange={(e) => setTimeLimit(Math.max(1, Math.min(600, +e.target.value || 1)))} disabled={running} />
        </label>
      </div>
      <div className="row">
        {running ? (
          <button className="primary" onClick={stop}>
            Stop solver
          </button>
        ) : (
          <button className="primary" onClick={solve} disabled={disabled}>
            {mode === 'full' ? 'Improve with clingo' : 'Solve with clingo'}
          </button>
        )}
        <button onClick={downloadLp} title="Download the ASP program to run with native clingo">
          .lp
        </button>
      </div>
      {mode === 'full' && !running && !full && !fullError && (
        <p className="hint small">
          Clingo chooses parts, cuts and links together, so every answer is buildable. It re-solves a few parts at a time
          (with the cuts and links around them) exactly, keeping each improvement.
        </p>
      )}
      {running && mode === 'full' && (
        <p className="small" data-testid="asp-live">
          {fullLive
            ? `${fullLive.windows} window(s), ${fullLive.improvements} improvement(s), cost ${fullLive.cost.toFixed(1)} after ${fullLive.seconds.toFixed(1)} s…`
            : 'Grounding and solving the first window…'}
        </p>
      )}
      {fullError && <p className="messages errors">{fullError}</p>}
      {full && mode === 'full' && (
        <div className="asp-result" data-testid="asp-result">
          <div className="badge ok">
            {full.provenOptimal ? 'Proven optimal' : full.improvements ? `Improved ${full.startCost.toFixed(1)} → ${full.cost.toFixed(1)}` : 'No improvement found'}
          </div>
          <p className="small">
            {full.windows} window(s), {full.improvements} improvement(s) in {full.seconds.toFixed(1)} s. Cuts and links on the board
            are clingo's own until you edit the layout.
          </p>
        </div>
      )}
      {running && mode !== 'full' && (
        <p className="small" data-testid="asp-live">
          {live ? `${live.models} model(s), cost [${live.costs.join(', ')}] after ${live.seconds.toFixed(1)} s…` : 'Grounding and solving…'}
        </p>
      )}
      {result && mode !== 'full' && (
        <div className="asp-result" data-testid="asp-result">
          <div className={`badge ${result.outcome === 'optimum' || result.outcome === 'timeout' ? 'ok' : 'bad'}`}>
            {OUTCOME_TEXT[result.outcome]}
          </div>
          {result.messages.length > 0 && (
            <ul className="messages errors">
              {result.messages.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          )}
          {result.encoding && (
            <p className="small">
              {result.models} model(s) in {result.seconds.toFixed(1)} s · {result.encoding.stats.candidates.toLocaleString()} candidate placements on{' '}
              {result.encoding.board.strips}×{result.encoding.board.holes}
              {result.costs.length > 0 && <> · cost [{result.costs.join(', ')}]</>}
            </p>
          )}
        </div>
      )}
      {(sa || asp) && (
        <>
          <table className="metrics compare">
            <thead>
              <tr>
                <th />
                <th>Annealing</th>
                <th>clingo</th>
              </tr>
            </thead>
            <tbody>
              {row('Buildable', (s) => (s.clean ? '✓' : '✗'))}
              {row('Used area', (s) => `${s.metrics.height}×${s.metrics.width}`)}
              {row('Cuts', (s) => String(s.metrics.cuts))}
              {row('Links', (s) => String(s.metrics.links))}
              {row('Unrouted', (s) => String(s.metrics.unrouted))}
              {row('Paper TD', (s) => String(s.metrics.paperTD))}
              {row('Time', (s) => `${s.seconds.toFixed(1)} s`)}
            </tbody>
          </table>
          <div className="row">
            <button onClick={() => sa && onShow(sa.layout)} disabled={!sa || running}>
              Show annealing
            </button>
            <button onClick={() => asp && onShow(asp.layout, asp.solution)} disabled={!asp || running}>
              Show clingo
            </button>
          </div>
          {asp && !asp.clean && (
            <p className="hint small">Tip: “Refine current” anneals from the clingo placement to repair it.</p>
          )}
        </>
      )}
    </section>
  );
}
