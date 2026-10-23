import { useEffect, useState } from 'react';
import type { ChipIndexEntry, DeviceJson } from './types.js';

const cache = new Map<string, Promise<DeviceJson>>();

function fetchJson<T>(url: string): Promise<T> {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json() as Promise<T>;
  });
}

export function useChipIndex() {
  const [chips, setChips] = useState<ChipIndexEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchJson<ChipIndexEntry[]>('/svd/index.json').then(setChips, (e) => setError(String(e)));
  }, []);
  return { chips, error };
}

export function useDevice(chip: ChipIndexEntry | undefined) {
  const [state, setState] = useState<{ id?: string; device?: DeviceJson; error?: string }>({});
  useEffect(() => {
    if (!chip) return;
    let live = true;
    let p = cache.get(chip.id);
    if (!p) {
      p = fetchJson<DeviceJson>(`/${chip.file}`);
      cache.set(chip.id, p);
    }
    p.then(
      (device) => live && setState({ id: chip.id, device }),
      (e) => {
        cache.delete(chip.id);
        if (live) setState({ id: chip.id, error: String(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [chip]);
  const ready = state.id === chip?.id;
  return {
    device: ready ? state.device : undefined,
    error: ready ? state.error : undefined,
    loading: !!chip && !ready,
  };
}
