import { Module } from '@nestjs/common';
import { LocalUserGuard } from './local-user.guard';

@Module({
  providers: [LocalUserGuard],
  exports: [LocalUserGuard],
})
export class AuthModule {}
