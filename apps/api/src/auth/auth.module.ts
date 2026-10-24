import { Module } from '@nestjs/common';
import { GoogleIdTokenGuard } from './google-id-token.guard';

@Module({
  providers: [GoogleIdTokenGuard],
  exports: [GoogleIdTokenGuard],
})
export class AuthModule {}
