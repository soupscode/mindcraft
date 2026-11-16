// The event contract is genesis/shared/events.js, used as it is (never copied).
// @ts-ignore: plain JavaScript without type declarations
import { validateEvent as validate, createUlidFactory as ulidFactory } from '../../shared/events.js';

export const validateEvent = validate as (event: unknown) => { ok: boolean; errors: string[] };
export const createUlidFactory = ulidFactory as (options?: { now?: () => number; random?: () => number }) => () => string;
