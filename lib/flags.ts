// Flags a player can pick: every country, plus the home nations and a few regions
// that field their own football teams. Images are in /public/flags (flag-icons, MIT).
import countries from './countries.json';

const EXTRA: [string, string][] = [
  ['gb-eng', 'England'], ['gb-sct', 'Scotland'], ['gb-wls', 'Wales'], ['gb-nir', 'Northern Ireland'],
  ['es-ct', 'Catalonia'], ['es-pv', 'Basque Country'], ['es-ga', 'Galicia'],
  ['eu', 'European Union'], ['un', 'United Nations']
];

export const FLAG_LIST: [string, string][] = [...(countries as [string, string][]), ...EXTRA]
  .sort((a, b) => a[1].localeCompare(b[1], 'en'));
export const FLAG_CODES = new Set(FLAG_LIST.map(f => f[0]));
export function flagName(code: string) { return FLAG_LIST.find(f => f[0] === code)?.[1] || ''; }

// a first guess from the browser's language, e.g. en-GB -> gb
export function guessFlag(): string {
  if (typeof navigator === 'undefined') return '';
  for (const l of navigator.languages || [navigator.language]) {
    const region = (l || '').split('-')[1];
    if (region && region.length === 2 && FLAG_CODES.has(region.toLowerCase())) return region.toLowerCase();
  }
  return '';
}
