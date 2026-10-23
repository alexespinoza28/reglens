// Write a config: plain-English request -> AI proposal -> RegLens verifies it
// with the deterministic decoder before showing it. An unverified proposal is
// never presented as an answer.

import { useEffect, useMemo, useState } from 'react';
import { bin, hex } from '../lib/decode';
import { WRITE_EXAMPLES } from '../lib/examples';
import { verifyProposal, type Proposal, type Verification } from '../lib/propose';
import { decodePayload, encodePayload } from '../lib/share';
import type { ChipIndexEntry, DeviceJson } from '../lib/types';

interface Props {
  device: DeviceJson | undefined;
  chip: ChipIndexEntry | undefined;
  payload: string;
  onPayload: (payload: string) => void;
  onOpenRegister: (key: string, value: string) => void;
}

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; proposal: Proposal; request: string; forKey: string; model?: string; attempts?: number }
  | { status: 'error'; error: string; forKey: string };

const TAG = { pass: 'PASS', fail: 'FAIL', note: 'NOTE' } as const;

export function WriteView({ device, chip, payload, onPayload, onOpenRegister }: Props) {
  const [request, setRequest] = useState(() => decodePayload<{ r: string }>(payload).r ?? '');
  const [state, setState] = useState<State>({ status: 'idle' });
  const [copied, setCopied] = useState(false);
  const chipId = chip?.id ?? '';
  const key = `${chipId}/${request.trim()}`;

  useEffect(() => {
    onPayload(request.trim() ? encodePayload({ r: request }) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // The badge comes from this browser's own run of the verifier, not the server's word.
  const verification: Verification | undefined = useMemo(
    // Verified against the request the proposal was made for.
    () => (state.status === 'done' && device ? verifyProposal(device, state.request, state.proposal) : undefined),
    [state, device],
  );

  const run = async () => {
    setState({ status: 'loading' });
    setCopied(false);
    const req = request.trim();
    try {
      const r = await fetch('/api/propose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chip: chipId, request: req }),
      });
      const res = (await r.json().catch(() => ({}))) as { proposal?: Proposal; error?: string; model?: string; attempts?: number };
      if (!r.ok || !res.proposal) throw new Error(res.error ?? `Request failed (HTTP ${r.status})`);
      setState({ status: 'done', proposal: res.proposal, request: req, forKey: key, model: res.model, attempts: res.attempts });
    } catch (e) {
      setState({ status: 'error', error: e instanceof Error ? e.message : String(e), forKey: key });
    }
  };

  const stale = (state.status === 'done' || state.status === 'error') && state.forKey !== key;
  const examples = WRITE_EXAMPLES.filter((x) => x.chips.includes(chipId));

  return (
    <>
      <section className="doctor-input">
        <form
          className="explain-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (request.trim()) void run();
          }}
        >
          <label className="ctl grow">
            <span>Describe the setup you want</span>
            <input value={request} maxLength={300} placeholder="e.g. PA5 push-pull output, low speed, no pull" onChange={(e) => setRequest(e.target.value)} />
          </label>
          <button type="submit" className="primary self-end" disabled={state.status === 'loading' || !request.trim()}>
            {state.status === 'loading' ? 'Proposing…' : 'Propose'}
          </button>
        </form>
        {examples.length > 0 && (
          <div className="examples">
            <span className="dim small">Try:</span>
            {examples.map((ex) => (
              <button key={ex.text} className="chip-btn" onClick={() => setRequest(ex.text)}>
                {ex.text}
              </button>
            ))}
          </div>
        )}
        <p className="dim small">
          The AI (NVIDIA Nemotron) maps your words to field values from the chip's real register list. RegLens does the
          arithmetic itself (BRR, PSC, ARR, CCR), decodes every value against the SVD, checks it against your words and
          numbers, and generates the C from the field values. Only a proposal that passes every check is marked verified.
        </p>
      </section>

      {state.status === 'error' && <div className="notice error">{state.error}</div>}

      {state.status === 'done' && verification && (
        <section className={`proposal ${verification.verified ? 'ok' : 'bad'} ${stale ? 'stale' : ''}`}>
          {stale && <div className="small dim">The request changed since this proposal. Press Propose again.</div>}
          <div className="proposal-head">
            <span className={`badge-lg ${verification.verified ? 'ok' : 'bad'}`}>
              {verification.verified ? 'Verified by the decoder' : 'Not verified'}
            </span>
            <span className="dim small">
              {state.model ? `Proposed by ${state.model}` : ''}
              {state.attempts && state.attempts > 1 ? ', second attempt after the first failed the checks' : ''}
            </span>
          </div>
          {!verification.verified && (
            <div className="notice error">
              RegLens could not verify this proposal, so don't use it. The failed checks are below; the values are shown
              only so you can see what went wrong.
            </div>
          )}

          <h3>Checks</h3>
          <ul className="checks">
            {verification.checks.map((c, i) => (
              <li key={i} className={c.status}>
                <span className={`tag ${c.status}`}>{TAG[c.status]}</span> {c.text}
              </li>
            ))}
          </ul>

          <h3>{verification.verified ? 'Register values' : 'Proposed values (not verified)'}</h3>
          {verification.results.map((r) => (
            <div key={r.key} className="write-block">
              <div className="write-head">
                <span className="mono strong">{r.key}</span>
                <span className="mono dim small">
                  after the write, from reset: {hex(r.value, r.register.size)}
                </span>
                {verification.verified && (
                  <button className="link small" onClick={() => onOpenRegister(r.key, hex(r.value, r.register.size))}>
                    Open in decoder
                  </button>
                )}
              </div>
              <div className="table-wrap">
                <table className="fields">
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th className="num">Value</th>
                      <th>SVD meaning</th>
                      <th>AI said</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.fields.map((f) => (
                      <tr key={f.field.name}>
                        <td className="mono strong">{f.field.name}</td>
                        <td className="mono num">
                          {f.field.width > 1 && f.field.width <= 4 ? `0b${bin(f.value, f.field.width)}` : f.value}
                        </td>
                        <td>{f.svdMeaning ?? <span className="dim">no named value</span>}</td>
                        <td className="dim">{f.claimed ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <div className="c-head">
            <h3>{verification.verified ? 'C' : 'C (not verified, for reference only)'}</h3>
            {state.proposal.cSource === 'reglens' && <span className="dim small">generated by RegLens from the field values above</span>}
            {verification.verified && (
              <button
                className="link small"
                onClick={() => {
                  void navigator.clipboard?.writeText(state.proposal.c.join('\n')).then(() => setCopied(true));
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
          </div>
          <pre className={`c-lines mono ${verification.verified ? '' : 'unverified'}`}>{state.proposal.c.join('\n') || '(none)'}</pre>
          {state.proposal.notes && <p className="small dim">AI note: {state.proposal.notes}</p>}
          {state.proposal.notesDropped && <p className="small dim">{state.proposal.notesDropped}</p>}
        </section>
      )}
    </>
  );
}
