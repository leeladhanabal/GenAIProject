import { ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticatedRequest } from './authenticated-request';
import { LOCAL_MOCK_USER, LocalUserGuard } from './local-user.guard';

function requestContext() {
  const request = { headers: {}, body: {} } as AuthenticatedRequest;
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as ExecutionContext;
  return { request, context };
}

describe('LocalUserGuard', () => {
  it.each(['development', 'test'])('accepts token-free requests in explicit local mode (%s)', (environment) => {
    const guard = new LocalUserGuard(new ConfigService({ AUTH_MODE: 'local-mock', NODE_ENV: environment }));
    const { request, context } = requestContext();
    expect(guard.canActivate(context)).toBe(true);
    expect(request.authUser).toEqual(LOCAL_MOCK_USER);
  });

  it('ignores client-supplied identity and gives each request its own fixed-user object', () => {
    const guard = new LocalUserGuard(new ConfigService({ AUTH_MODE: 'local-mock', NODE_ENV: 'test' }));
    const first = requestContext();
    first.request.headers.authorization = 'Bearer pretend-user';
    first.request.headers['x-user-id'] = 'another-user';
    first.request.body = { subject: 'another-user', authUser: { subject: 'another-user' } };
    guard.canActivate(first.context);
    expect(first.request.authUser).toEqual(LOCAL_MOCK_USER);
    first.request.authUser.subject = 'changed-in-one-request';
    const second = requestContext(); guard.canActivate(second.context);
    expect(second.request.authUser).toEqual(LOCAL_MOCK_USER);
    expect(second.request.authUser).not.toBe(first.request.authUser);
  });

  it.each(['', 'google', 'disabled'])('rejects authentication modes other than local-mock (%s)', (mode) => {
    expect(() => new LocalUserGuard(new ConfigService({ AUTH_MODE: mode, NODE_ENV: 'test' })))
      .toThrow(ServiceUnavailableException);
  });

  it.each(['production', 'staging', ''])('rejects local authentication outside development/test (%s)', (environment) => {
    expect(() => new LocalUserGuard(new ConfigService({ AUTH_MODE: 'local-mock', NODE_ENV: environment })))
      .toThrow(ServiceUnavailableException);
  });

  it('checks the configured mode again on each request', () => {
    const config = new ConfigService({ AUTH_MODE: 'local-mock', NODE_ENV: 'test' });
    const guard = new LocalUserGuard(config);
    const get = jest.spyOn(config, 'get').mockReturnValueOnce('local-mock').mockReturnValueOnce('production');
    expect(() => guard.canActivate(requestContext().context)).toThrow(ServiceUnavailableException);
    get.mockRestore();
  });
});
