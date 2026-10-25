import { CanActivate, ExecutionContext, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticatedRequest, AuthenticatedUser } from './authenticated-request';

export const LOCAL_API_HOST = '127.0.0.1';
export const LOCAL_MOCK_USER: Readonly<AuthenticatedUser> = Object.freeze({
  issuer: 'local-mock',
  subject: 'local-test-user',
  email: 'local-test@example.test',
  displayName: 'Local Test User',
});

@Injectable()
export class LocalUserGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {
    this.assertLocalMode();
  }

  canActivate(context: ExecutionContext): boolean {
    this.assertLocalMode();
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    // Identity is server-defined. Headers and request bodies never select it.
    // Clone the frozen template so one request cannot mutate another's identity.
    request.authUser = { ...LOCAL_MOCK_USER };
    return true;
  }

  private assertLocalMode(): void {
    if (this.config.get<string>('AUTH_MODE') !== 'local-mock' ||
        !['development', 'test'].includes(this.config.get<string>('NODE_ENV') ?? '')) {
      throw new ServiceUnavailableException({
        code: 'local_auth_disabled',
        message: 'Fixed-user authentication requires AUTH_MODE=local-mock and NODE_ENV=development or test. It is unavailable for production.',
      });
    }
  }
}
