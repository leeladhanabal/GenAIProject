import { Request } from 'express';

export interface AuthenticatedUser {
  issuer: string;
  subject: string;
  email: string | null;
  displayName: string | null;
}

export interface AuthenticatedRequest extends Request {
  authUser: AuthenticatedUser;
}
