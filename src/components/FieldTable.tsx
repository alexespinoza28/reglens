import type { DecodedRegister } from '../lib/decode';
import type { DeviceJson } from '../lib/types';
import { bin, bitRange, enumTable } from '../lib/decode';

interface Props {
  device: DeviceJson;
  decoded: DecodedRegister;
  hovered: string | null;
  onHover: (name: string | null) => void;
  onSetField: (lsb: number, width: number, value: number) => void;
  onlyChanged: boolean;
}

export function FieldTable({ device, decoded, hovered, onHover, onSetField, onlyChanged }: Props) {
  const rows = onlyChanged ? decoded.fields.filter((f) => f.changedFromReset) : decoded.fields;
  return (
    <div className="table-wrap">
      <table className="fields">
        <thead>
          <tr>
            <th>Field</th>
            <th>Bits</th>
            <th className="num">Value</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                Every field matches its reset value.
              </td>
            </tr>
          )}
          {rows.map((f) => {
            const table = enumTable(device, f.field);
            return (
              <tr
                key={f.field.name}
                className={`${hovered === f.field.name ? 'hover' : ''} ${f.changedFromReset ? 'changed' : ''}`}
                onMouseEnter={() => onHover(f.field.name)}
                onMouseLeave={() => onHover(null)}
              >
                <td className="mono strong">
                  {f.field.name}
                  {f.changedFromReset && (
                    <span className="badge" title={`Reset value: ${f.resetValue}`}>
                      changed
                    </span>
                  )}
                </td>
                <td className="mono dim">{bitRange(f.field)}</td>
                <td className="mono num">
                  {f.field.width > 1 ? (
                    <>
                      <span className="dim">0b</span>
                      {bin(f.value, f.field.width)} <span className="dim">= {f.value}</span>
                    </>
                  ) : (
                    f.value
                  )}
                </td>
                <td>
                  {table ? (
                    <select
                      className={`meaning ${f.unknownValue ? 'unknown' : ''}`}
                      value={f.meaning?.v ?? ''}
                      onChange={(e) => onSetField(f.field.lsb, f.field.width, Number(e.target.value))}
                      aria-label={`Set ${f.field.name}`}
                    >
                      {f.unknownValue && <option value="">{f.value}: not listed (reserved?)</option>}
                      {table
                        .filter((x) => x.v !== null)
                        .map((x) => (
                          <option key={x.v} value={x.v!}>
                            {x.v}: {x.n}
                          </option>
                        ))}
                    </select>
                  ) : null}
                  {(f.meaning?.d ?? f.field.description) && (
                    <div className="desc">{f.meaning?.d ?? f.field.description}</div>
                  )}
                  {f.meaning?.d && f.field.description && <div className="desc dim">{f.field.description}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
