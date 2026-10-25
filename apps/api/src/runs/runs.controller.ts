import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest } from '../auth/authenticated-request';
import { LocalUserGuard } from '../auth/local-user.guard';
import { CreateRunDto } from './dto/create-run.dto';
import { RunsService } from './runs.service';

@Controller()
@UseGuards(LocalUserGuard)
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get('plans/:planId/run-policy')
  policy(@Req() request: AuthenticatedRequest, @Param('planId', new ParseUUIDPipe()) planId: string) {
    return this.runs.policy(request.authUser, planId);
  }

  @Post('plans/:planId/runs')
  @HttpCode(202)
  create(@Req() request: AuthenticatedRequest, @Param('planId', new ParseUUIDPipe()) planId: string,
    @Headers('idempotency-key') key: string, @Body() input: CreateRunDto) {
    return this.runs.create(request.authUser, planId, key, input);
  }

  @Get('runs/:runId')
  get(@Req() request: AuthenticatedRequest, @Param('runId', new ParseUUIDPipe()) runId: string) {
    return this.runs.get(request.authUser, runId);
  }

  @Post('runs/:runId/cancel')
  @HttpCode(202)
  cancel(@Req() request: AuthenticatedRequest, @Param('runId', new ParseUUIDPipe()) runId: string) {
    return this.runs.cancel(request.authUser, runId);
  }
}
