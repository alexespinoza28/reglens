import { citeText, type Cite } from '../lib/cite';
import type { Finding, Quantity } from '../lib/doctor';

export function CiteChips({ cites }: { cites: Cite[] }) {
  if (!cites.length) return null;
  return (
    <ul className="cites">
      {cites.map((c) => (
        <li key={`${c.register}.${c.field}`} className="mono">
          {citeText(c)}
        </li>
      ))}
    </ul>
  );
}

const LABEL = { error: 'Error', warn: 'Warning', info: 'Note' } as const;

export function FindingCard({ f }: { f: Finding }) {
  return (
    <article className={`finding ${f.severity}`}>
      <div className="finding-head">
        <span className={`sev ${f.severity}`}>{LABEL[f.severity]}</span>
        <h3>{f.title}</h3>
      </div>
      <p>{f.detail}</p>
      <CiteChips cites={f.cites} />
      <div className="rule dim small mono">rule: {f.rule}</div>
    </article>
  );
}

export function QuantityCard({ q }: { q: Quantity }) {
  const bad = q.kind === 'baud' && q.numbers.errorPct !== undefined && Math.abs(q.numbers.errorPct) > 2;
  return (
    <article className={`quantity ${bad ? 'bad' : ''}`}>
      <div className="dim small">{q.title}</div>
      {q.display ? <div className="big mono">{q.display}</div> : <div className="needs">Needs {q.needs}.</div>}
      {q.display && q.needs && <div className="needs small">Also needs {q.needs}.</div>}
      {q.lines.length > 0 && (
        <ol className="steps mono small">
          {q.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      )}
      <CiteChips cites={q.cites} />
    </article>
  );
}
