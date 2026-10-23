import { useState } from 'react';
import { CLIENT_TIMEOUT_MS, timeoutMessage, useElapsed } from '../lib/useElapsed';

interface Props {
  title: string;
  note: string;
  /** JSON body for POST /api/explain, given the question. */
  body: (question: string) => Record<string, unknown>;
  /** Changes whenever the input being explained changes; marks old results stale. */
  inputKey: string;
  /** When set, the question comes from elsewhere on the page and no input box is shown. */
  question?: string;
  placeholder?: string;
}

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; text: string; forKey: string; model?: string }
  | { status: 'error'; error: string; forKey: string };

export function ExplainPanel({ title, note, body, inputKey, question: external, placeholder }: Props) {
  const [own, setOwn] = useState('');
  const [state, setState] = useState<State>({ status: 'idle' });
  const elapsed = useElapsed(state.status === 'loading');
  const question = (external ?? own).trim();
  const key = `${inputKey}/${question}`;

  const run = async () => {
    setState({ status: 'loading' });
    try {
      const r = await fetch('/api/explain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body(question)),
        signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
      });
      const res = (await r.json().catch(() => ({}))) as { text?: string; error?: string; model?: string };
      if (!r.ok || !res.text) throw new Error(res.error ?? `Request failed (HTTP ${r.status})`);
      setState({ status: 'done', text: res.text, forKey: key, model: res.model });
    } catch (e) {
      setState({ status: 'error', error: timeoutMessage(e) ?? (e instanceof Error ? e.message : String(e)), forKey: key });
    }
  };

  const stale = (state.status === 'done' || state.status === 'error') && state.forKey !== key;

  return (
    <section className="explain">
      <div className="explain-head">
        <h2>{title}</h2>
        <span className="dim small">{note}</span>
      </div>
      <form
        className="explain-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        {external === undefined && (
          <input
            placeholder={placeholder ?? 'Optional: what are you debugging?'}
            maxLength={200}
            value={own}
            onChange={(e) => setOwn(e.target.value)}
          />
        )}
        <button type="submit" className="primary" disabled={state.status === 'loading'}>
          {state.status === 'loading' ? `Explaining… ${elapsed} s` : 'Explain'}
        </button>
      </form>
      {state.status === 'done' && (
        <div className={`explain-out ${stale ? 'stale' : ''}`}>
          {stale && <div className="small dim">The input changed since this explanation. Run Explain again.</div>}
          {state.text.split('\n').map((line, i) => (line.trim() ? <p key={i}>{line}</p> : null))}
          {state.model === 'decoder' && <div className="small dim">Shown from the decoder: the AI reply failed RegLens's checks.</div>}
        </div>
      )}
      {state.status === 'error' && <div className="explain-out error">{state.error}</div>}
    </section>
  );
}
