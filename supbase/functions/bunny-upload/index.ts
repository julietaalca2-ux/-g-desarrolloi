/* ÖG — Edge Function bunny-upload (punto de entrada). La lógica está en handler.ts. */
import { createHandler } from './handler.ts';

Deno.serve(
  createHandler({
    env: (name) => Deno.env.get(name),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    random: () => Math.random().toString(36).slice(2, 8),
  }),
);
