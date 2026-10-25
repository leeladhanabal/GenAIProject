import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PlansController } from './plans.controller';
import { PlansService } from './plans.service';
import { AI_PLANNING_ADAPTER } from './ai-planning.adapter';
import { GroqPlanningAdapter } from './groq-planning.adapter';

@Module({
  imports: [AuthModule],
  controllers: [PlansController],
  providers: [PlansService, { provide: AI_PLANNING_ADAPTER, useClass: GroqPlanningAdapter }],
})
export class PlansModule {}
