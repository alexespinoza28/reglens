import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DeviceJson } from '../src/lib/types';

const cache = new Map<string, DeviceJson>();

/** Load generated chip data the same way the explain function does. */
export function device(chip: string): DeviceJson {
  let d = cache.get(chip);
  if (!d) {
    d = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'public', 'svd', `${chip}.json`), 'utf8')) as DeviceJson;
    cache.set(chip, d);
  }
  return d;
}
