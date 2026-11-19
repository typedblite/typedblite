import 'reflect-metadata';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { CommandBus, CqrsModule, QueryBus } from '@nestjs/cqrs';
import { ExpressAdapter } from '@nestjs/platform-express';
import { unwrap } from '@devx-micro/app-http';
import { CqrsToolRuntime } from '@devx-micro/app-runtime';
import { EngineHostModule } from './engine-host.module.js';
import { createHostOperations } from './operations.js';

const RUNTIME = Symbol('typedblite-host.runtime');

/** The parts of an HTTP request the loopback check reads, so no HTTP framework's types are needed. */
export interface PeerRequest {
  readonly socket: { readonly remoteAddress?: string | undefined };
  readonly headers: { readonly host?: string | undefined };
}

/**
 * HTTP, as generic dispatch over the operation list: one route per verb, not one per operation, so each input
 * shape is declared once, in `operations.ts`, and an operation added there is reachable here with no change.
 *
 * `POST /api/typedblite-host/ops/:operation` takes the operation's input as the JSON body and answers its data; an
 * error answers the status its exit code maps to (`@devx-micro/app-http`). A statement the engine refuses is a
 * 200 with `kind: "refused"`, as it is an exit code 0 on the CLI: the answer is data.
 */
@Controller('typedblite-host')
export class HostController {
  constructor(@Inject(RUNTIME) private readonly runtime: CqrsToolRuntime) {}

  /** The operations, with the input schema of each. */
  @Get('help')
  help(): { operations: unknown } {
    return { operations: this.runtime.listOperations() };
  }

  @Post('ops/:operation')
  @HttpCode(200)
  async dispatch(@Param('operation') operation: string, @Body() body: unknown): Promise<unknown> {
    const input = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    return unwrap(await this.runtime.dispatch(operation, input));
  }
}

@Module({
  imports: [EngineHostModule, CqrsModule],
  controllers: [HostController],
  providers: [
    {
      provide: RUNTIME,
      inject: [CommandBus, QueryBus],
      useFactory: (commandBus: CommandBus, queryBus: QueryBus) =>
        new CqrsToolRuntime({ commandBus, queryBus, operations: createHostOperations() }),
    },
  ],
})
export class HostHttpModule {}

/** The only address the host listens on. Authentication and a non-loopback listener are a later feature's. */
export const LOOPBACK = '127.0.0.1';

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/**
 * Refuses a request that did not come from this machine, or that names another host.
 *
 * 🔴 Binding to loopback is the first fence; this is the second. A web page in the user's browser can make the
 * browser send a request to `127.0.0.1`, and a DNS name the page controls can be pointed there (DNS rebinding),
 * so the peer address alone is not enough: the `Host` header must also name loopback. The host runs statements
 * against real stores, so it does not rely on the network being friendly.
 */
export function loopbackOnly(request: PeerRequest, _response: unknown, next: (error?: unknown) => void): void {
  const peer = request.socket.remoteAddress ?? '';
  const host = request.headers.host ?? '';
  if (!LOOPBACK_PEERS.has(peer) || !LOOPBACK_HOST.test(host)) {
    next(new ForbiddenException('typedblite-host answers loopback requests only.'));
    return;
  }
  next();
}

/**
 * An Express adapter that listens on loopback whatever it is asked.
 *
 * 🔴 `defineApp` calls `app.listen(port)`, which binds every interface, and the host is loopback only. Patching
 * `app.listen` does not work: Nest's application is a Proxy whose `set` trap discards the assignment (the line
 * looks right, type-checks, and leaves the server on every interface), and calling the class's `listen` from
 * outside the proxy fails on its first `this.isListening = true`. The adapter is the seam Nest offers.
 * `test/http.test.ts` reads the bound address.
 */
export class LoopbackExpressAdapter extends ExpressAdapter {
  override listen(port: string | number, callback?: () => void): ReturnType<ExpressAdapter['listen']>;
  override listen(port: string | number, hostname: string, callback?: () => void): ReturnType<ExpressAdapter['listen']>;
  override listen(port: string | number, ...args: unknown[]): ReturnType<ExpressAdapter['listen']> {
    const callback = args.find((argument): argument is () => void => typeof argument === 'function');
    return super.listen(port, LOOPBACK, callback);
  }
}

/** Builds the HTTP application, not yet listening: `defineApp` sets the prefix and calls `listen`. */
export async function createHostHttp(): Promise<INestApplication> {
  const app = await NestFactory.create(HostHttpModule, new LoopbackExpressAdapter(), { logger: ['error'] });
  app.use(loopbackOnly);
  app.enableShutdownHooks();
  return app;
}
