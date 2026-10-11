// Tournament codes: 5 characters from an alphabet without look-alikes (no I, O, 0, 1).
export const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function normCode(c: string) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); }
