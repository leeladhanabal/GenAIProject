import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { AuthenticatedRequest, AuthenticatedUser } from './authenticated-request';

@Injectable()
export class GoogleIdTokenGuard implements CanActivate {
  private readonly client = new OAuth2Client();

  constructor(private readonly configService: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const audience = this.configService.get<string>('GOOGLE_CLIENT_ID')?.trim();
    if (!audience) {
      throw new ServiceUnavailableException({
        code: 'authentication_not_configured',
        message: 'Google authentication is not configured',
      });
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.header('authorization');
    const match = authorization?.match(/^Bearer\s+(\S+)$/i);
    if (!match) {
      throw new UnauthorizedException('A Google ID token bearer credential is required');
    }

    let payload;
    try {
      const ticket = await this.client.verifyIdToken({
        idToken: match[1],
        audience,
      });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedException('The Google ID token is invalid or expired');
    }

    if (
      !payload?.sub ||
      !payload.iss ||
      !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss) ||
      payload.email_verified !== true
    ) {
      throw new UnauthorizedException('The Google ID token has incomplete identity claims');
    }

    const user: AuthenticatedUser = {
      issuer: payload.iss,
      subject: payload.sub,
      email: payload.email ?? null,
      displayName: payload.name ?? null,
    };
    request.authUser = user;
    return true;
  }
}
