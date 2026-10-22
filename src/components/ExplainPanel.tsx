import { useState } from 'react';

interface Props {
  chip: string;
  registerKey: string;
  valueHex: string;
}

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; text: string; forKey: string }
  | { status: 'error'; error: string; forKey: string };

export function ExplainPanel({ chip, registerKey, valueHex }: Props) {
  const [question, setQuestion] = useState('');
  const [state, setState] = useState<State>({ status: 'idle' });
  const key = `${chip}/${registerKey}/${valueHex}/${question.trim()}`;

  const run = async () => {
    setState({ status: 'loading' });
    try {
      const r = await fetch('/api/explain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chip, register: registerKey, value: valueHex, question: question.trim() || undefined }),
      });
      const body = (await r.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!r.ok || !body.text) throw new Error(body.error ?? `Request failed (HTTP ${r.status})`);
      setState({ status: 'done', text: body.text, forKey: key });
    } catch (e) {
      setState({ status: 'error', error: e instanceof Error ? e.message : String(e), forKey: key });
    }
  };

  const stale = (state.status === 'done' || state.status === 'error') && state.forKey !== key;

  return (
    <section className="explain">
      <div className="explain-head">
        <h2>Explain this value</h2>
        <span className="dim small">AI summary of the decoded fields only. It cannot add bits the SVD doesn't define.</span>
      </div>
      <form
        className="explain-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          placeholder="Optional: what are you debugging? e.g. “PA5 LED won't toggle”"
          maxLength={200}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button type="submit" className="primary" disabled={state.status === 'loading'}>
          {state.status === 'loading' ? 'Explaining…' : 'Explain'}
        </button>
      </form>
      {state.status === 'done' && (
        <div className={`explain-out ${stale ? 'stale' : ''}`}>
          {stale && <div className="small dim">Value changed since this explanation. Run Explain again.</div>}
          {state.text.split('\n').map((line, i) =>
            line.trim() ? <p key={i}>{line}</p> : null,
          )}
        </div>
      )}
      {state.status === 'error' && <div className="explain-out error">{state.error}</div>}
    </section>
  );
}
