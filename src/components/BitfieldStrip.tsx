// A reference-manual style register figure: bit numbers on top, one box per
// field, 16 bits per row. Click any bit to flip it.

import type { DecodedField, DecodedRegister } from '../lib/decode';
import { bits } from '../lib/decode';

interface Props {
  decoded: DecodedRegister;
  hovered: string | null;
  onHover: (name: string | null) => void;
  onToggleBit: (bit: number) => void;
}

interface Segment {
  kind: 'field' | 'reserved';
  hi: number; // highest bit in this row segment
  lo: number;
  field?: DecodedField;
  index: number; // field index, for alternating shading
}

function rowSegments(d: DecodedRegister, rowHi: number, rowLo: number): Segment[] {
  const owner = new Map<number, { f: DecodedField; i: number }>();
  d.fields.forEach((f, i) => {
    for (let b = f.field.lsb; b < f.field.lsb + f.field.width; b++) owner.set(b, { f, i });
  });
  const segs: Segment[] = [];
  let b = rowHi;
  while (b >= rowLo) {
    const o = owner.get(b);
    let lo = b;
    while (lo - 1 >= rowLo && owner.get(lo - 1)?.f === o?.f) lo--;
    segs.push(
      o
        ? { kind: 'field', hi: b, lo, field: o.f, index: o.i }
        : { kind: 'reserved', hi: b, lo, index: -1 },
    );
    b = lo - 1;
  }
  return segs;
}

export function BitfieldStrip({ decoded, hovered, onHover, onToggleBit }: Props) {
  const size = decoded.register.size;
  const rows: [number, number][] = [];
  for (let hi = size - 1; hi >= 0; hi -= 16) rows.push([hi, Math.max(hi - 15, 0)]);

  return (
    <div className="strip" aria-label="Register bitfields">
      {rows.map(([hi, lo]) => {
        const cols = hi - lo + 1;
        return (
          <div className="strip-row" key={hi} style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
            {Array.from({ length: cols }, (_, i) => (
              <div className="bitno mono" key={`n${i}`}>
                {hi - i}
              </div>
            ))}
            {rowSegments(decoded, hi, lo).map((s) => {
              const span = s.hi - s.lo + 1;
              const f = s.field;
              const name = f?.field.name;
              const cls = [
                'seg',
                s.kind,
                s.kind === 'field' && s.index % 2 ? 'alt' : '',
                f?.changedFromReset ? 'changed' : '',
                name && hovered === name ? 'hover' : '',
                f?.unknownValue ? 'unknown' : '',
              ].join(' ');
              const vertical = span === 1 && (name?.length ?? 0) > 2;
              return (
                <div
                  key={`${s.hi}`}
                  className={cls}
                  style={{ gridColumn: `span ${span}` }}
                  onMouseEnter={() => onHover(name ?? null)}
                  onMouseLeave={() => onHover(null)}
                  title={
                    f
                      ? `${f.field.name}: ${f.value}${f.meaning ? ` (${f.meaning.n})` : ''}${f.field.description ? ` · ${f.field.description}` : ''}`
                      : 'Reserved'
                  }
                >
                  <div className={`seg-name mono ${vertical ? 'vertical' : ''}`}>{name ?? 'Res.'}</div>
                  <div className="seg-bits" style={{ gridTemplateColumns: `repeat(${span}, minmax(0, 1fr))` }}>
                    {Array.from({ length: span }, (_, i) => {
                      const bit = s.hi - i;
                      const on = bits(decoded.value, bit, 1) === 1;
                      const warn = s.kind === 'reserved' && on;
                      return (
                        <button
                          key={bit}
                          type="button"
                          className={`bit mono ${on ? 'on' : ''} ${warn ? 'warn' : ''}`}
                          onClick={() => onToggleBit(bit)}
                          aria-label={`Bit ${bit} is ${on ? 1 : 0}, click to flip`}
                        >
                          {on ? 1 : 0}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
