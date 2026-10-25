import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  ParseIntPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../auth/authenticated-request';
import { LocalUserGuard } from '../auth/local-user.guard';
import { CreatePlanDto } from './dto/create-plan.dto';
import { CreatePlanVersionDto } from './dto/create-plan-version.dto';
import { PlansService } from './plans.service';
import { GeneratePlanDto, ReviewScriptDto } from './dto/generate-plan.dto';
import { Response } from 'express';

@Controller()
@UseGuards(LocalUserGuard)
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

  @Post('plans/:planId/generate')
  generate(
    @Req() request: AuthenticatedRequest,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Body() input: GeneratePlanDto,
  ) {
    return this.plansService.generate(request.authUser, planId, input);
  }

  @Post('plans/:planId/versions/:version/review')
  review(
    @Req() request: AuthenticatedRequest,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Param('version', ParseIntPipe) version: number,
    @Body() input: ReviewScriptDto,
  ) {
    return this.plansService.reviewScript(request.authUser, planId, version, input);
  }

  @Get('plans/:planId/versions/:version/script')
  async download(
    @Req() request: AuthenticatedRequest,
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Param('version', ParseIntPipe) version: number,
    @Res() response: Response,
  ) {
    const script = await this.plansService.downloadScript(request.authUser, planId, version);
    response.set({ 'Content-Type': 'application/javascript; charset=utf-8',
      'Content-Disposition': `attachment; filename="plan-${planId}-v${version}.js"`,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'X-Script-SHA256': script.sha256 });
    response.send(script.content);
  }
}
