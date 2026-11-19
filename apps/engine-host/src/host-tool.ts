import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { CqrsToolRuntime, type ToolOperationDescriptor } from '@devx-micro/app-runtime';
import type { AppToolHandle } from '@devx-micro/app-main';

import { EngineHostModule } from './engine-host.module.js';
import { createHostOperations } from './operations.js';

/**
 * A host to talk to: the Nest application context, and the runtime over its buses.
 *
 * Each entry point (a one-shot CLI call, the REPL, the sidecar) builds its own, so the sessions live as long
 * as that process does and no longer. `close` releases every file the host holds.
 *
 * 🔴 Nest logs only errors, and to stderr: the sidecar's stdout is one JSON envelope per line, and a log line
 * there would break its client.
 */
export async function createHostTool(): Promise<AppToolHandle> {
  const context = await NestFactory.createApplicationContext(EngineHostModule, { logger: ['error'] });
  const operations: ToolOperationDescriptor<any>[] = createHostOperations();
  const runtime = new CqrsToolRuntime({
    commandBus: context.get(CommandBus, { strict: false }),
    queryBus: context.get(QueryBus, { strict: false }),
    operations,
  });
  return { runtime, close: () => context.close() };
}
