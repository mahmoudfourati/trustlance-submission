/** Case-insensitive address equality; `undefined` (no wallet) never matches. */
export const sameAddress = (a: string | undefined, b: string) => a !== undefined && a.toLowerCase() === b.toLowerCase()
