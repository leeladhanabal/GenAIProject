import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module';
import { ARTIFACT_STORAGE, createArtifactStorage } from '../artifacts/artifact-storage';
import { Phase5Controller } from './phase5.controller';
import { Phase5Service } from './phase5.service';

@Module({ imports: [AuthModule], controllers: [Phase5Controller], providers: [Phase5Service,
  { provide: ARTIFACT_STORAGE, inject: [ConfigService], useFactory: createArtifactStorage }],
})
export class Phase5Module {}
