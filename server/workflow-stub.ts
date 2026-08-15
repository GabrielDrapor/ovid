/**
 * Stand-in for the Cloudflare Workflows translation backend when running
 * self-hosted. That backend is optional and off by default (jobs default to
 * backend='railway'); the self-host path uses the translator service instead,
 * so the `cloudflare:workers` import is swapped out at build time.
 */

export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env
  ) {}
  async run(_event: unknown, _step: unknown): Promise<void> {
    throw new Error(
      'Cloudflare Workflows backend is not available in self-hosted mode'
    );
  }
}

export type WorkflowStep = never;
export type WorkflowEvent<T = unknown> = { payload: T };
