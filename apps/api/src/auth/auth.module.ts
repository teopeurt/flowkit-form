import {
  All,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Module,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthError } from '@naakwu/flowkit-auth';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import type { Request, Response } from 'express';

import { auth, type DemoAuth } from './auth.config';
import {
  resolveOrganizationContext,
  type BetterAuthSession,
  type OrganizationContext,
} from './organization-context';

export const BETTER_AUTH_INSTANCE = Symbol('BETTER_AUTH_INSTANCE');

@Controller('api/auth')
export class BetterAuthController {
  private readonly betterAuthHandler: ReturnType<typeof toNodeHandler>;

  constructor(@Inject(BETTER_AUTH_INSTANCE) authInstance: DemoAuth) {
    this.betterAuthHandler = toNodeHandler(authInstance);
  }

  @All('*path')
  handle(@Req() request: Request, @Res() response: Response) {
    return this.betterAuthHandler(request, response);
  }
}

type AuthenticatedRequest = Request & {
  principal?: OrganizationContext['principal'];
  organizationContext?: OrganizationContext;
};

export const ORGANIZATION_CONTEXT_PROVIDER = Symbol('ORGANIZATION_CONTEXT_PROVIDER');

export type OrganizationContextProvider = {
  resolve(headers: Headers): Promise<OrganizationContext | null>;
};

@Injectable()
export class OrganizationContextGuard implements CanActivate {
  constructor(
    @Inject(ORGANIZATION_CONTEXT_PROVIDER)
    private readonly contexts: OrganizationContextProvider,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    try {
      const organizationContext = await this.contexts.resolve(fromNodeHeaders(request.headers));
      if (!organizationContext) throw new UnauthorizedException('Authentication required.');
      request.organizationContext = organizationContext;
      request.principal = organizationContext.principal;
      return true;
    } catch (error) {
      if (error instanceof AuthError && error.code === 'unauthenticated') {
        throw new UnauthorizedException(error.message);
      }
      if (error instanceof AuthError) throw new ForbiddenException(error.message);
      throw error;
    }
  }
}

@Module({
  controllers: [BetterAuthController],
  providers: [
    { provide: BETTER_AUTH_INSTANCE, useValue: auth },
    OrganizationContextGuard,
    {
      provide: ORGANIZATION_CONTEXT_PROVIDER,
      inject: [BETTER_AUTH_INSTANCE],
      useFactory: (authInstance: DemoAuth): OrganizationContextProvider => ({
        async resolve(headers) {
          const session = await authInstance.api.getSession({ headers });
          return session ? resolveOrganizationContext(session as BetterAuthSession) : null;
        },
      }),
    },
  ],
  exports: [OrganizationContextGuard, ORGANIZATION_CONTEXT_PROVIDER],
})
export class AuthModule {}
