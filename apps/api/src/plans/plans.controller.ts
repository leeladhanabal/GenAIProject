import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../auth/authenticated-request';
import { GoogleIdTokenGuard } from '../auth/google-id-token.guard';
import { CreatePlanDto } from './dto/create-plan.dto';
import { CreatePlanVersionDto } from './dto/create-plan-version.dto';
import { PlansService } from './plans.service';

@Controller()
@UseGuards(GoogleIdTokenGuard)
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

  @Post('projects/:projectId/plans')
  createPlan(
    @Req() request: AuthenticatedRequest,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() input: CreatePlanDto,
  ) {
    return this.plansService.createPlan(request.authUser, projectId, input);
  }

  @Get('projects/:projectId/plans')
  listPlans(
    @Req() request: AuthenticatedRequest,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.plansService.listPlans(request.authUser, projectId);
  }

  @Get('plans/:planId')
  getPlan(
    @Req() request: AuthenticatedRequest,
    @Param('planId', new ParseUUIDPipe()) planId: string,
  ) {
    return this.plansService.getPlan(request.authUser, planId);
  }

  @Post('plans/:planId/versions')
  createVersion(
    @Req() request: AuthenticatedRequest,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Body() input: CreatePlanVersionDto,
  ) {
    return this.plansService.createVersion(request.authUser, planId, input);
  }
}
