import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AuthenticatedRequest } from '../auth/authenticated-request';
import { LocalUserGuard } from '../auth/local-user.guard';
import { DeleteProjectDto, RetentionPolicyDto, SlaPolicyDto } from './phase5.dto';
import { Phase5Service } from './phase5.service';

@Controller()
@UseGuards(LocalUserGuard)
export class Phase5Controller {
  constructor(private readonly service: Phase5Service) {}
  @Get('runs/:runId/reports')
  reports(@Req() req: AuthenticatedRequest, @Param('runId', new ParseUUIDPipe()) id: string) { return this.service.reports(req.authUser, id); }
  @Get('runs/:runId/comparison')
  comparison(@Req() req: AuthenticatedRequest, @Param('runId', new ParseUUIDPipe()) id: string,
    @Query('baselineRunId', new ParseUUIDPipe()) baseline: string) { return this.service.compare(req.authUser, id, baseline); }
  @Post('runs/:runId/results/retry') @HttpCode(202)
  retry(@Req() req: AuthenticatedRequest, @Param('runId', new ParseUUIDPipe()) id: string) { return this.service.retryResults(req.authUser, id); }
  @Get('projects/:projectId/artifacts')
  artifacts(@Req() req: AuthenticatedRequest, @Param('projectId', new ParseUUIDPipe()) id: string) { return this.service.artifacts(req.authUser, id); }
  @Post('artifacts/:artifactId/download-link') @HttpCode(200)
  link(@Req() req: AuthenticatedRequest, @Param('artifactId', new ParseUUIDPipe()) id: string) { return this.service.downloadLink(req.authUser, id); }
  @Get('artifacts/:artifactId/content')
  async content(@Req() req: AuthenticatedRequest, @Param('artifactId', new ParseUUIDPipe()) id: string,
    @Query('token') token: string, @Res() response: Response) {
    const file = await this.service.download(req.authUser, id, token);
    response.set({ 'Content-Type': file.contentType, 'Content-Disposition': `attachment; filename="${file.filename}"`,
      'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', "Content-Security-Policy": "sandbox; default-src 'none'" });
    response.send(file.content);
  }
  @Get('projects/:projectId/sla')
  sla(@Req() req: AuthenticatedRequest, @Param('projectId', new ParseUUIDPipe()) id: string) { return this.service.sla(req.authUser, id); }
  @Put('projects/:projectId/sla')
  setSla(@Req() req: AuthenticatedRequest, @Param('projectId', new ParseUUIDPipe()) id: string, @Body() body: SlaPolicyDto) { return this.service.sla(req.authUser, id, body); }
  @Get('projects/:projectId/retention')
  retention(@Req() req: AuthenticatedRequest, @Param('projectId', new ParseUUIDPipe()) id: string) { return this.service.retention(req.authUser, id); }
  @Put('projects/:projectId/retention')
  setRetention(@Req() req: AuthenticatedRequest, @Param('projectId', new ParseUUIDPipe()) id: string, @Body() body: RetentionPolicyDto) { return this.service.retention(req.authUser, id, body); }
  @Get('projects/:projectId/notifications')
  notifications(@Req() req: AuthenticatedRequest, @Param('projectId', new ParseUUIDPipe()) id: string) { return this.service.notifications(req.authUser, id); }
  @Post('notifications/:notificationId/read') @HttpCode(200)
  read(@Req() req: AuthenticatedRequest, @Param('notificationId', new ParseUUIDPipe()) id: string) { return this.service.readNotification(req.authUser, id); }
  @Post('projects/:projectId/exports')
  export(@Req() req: AuthenticatedRequest, @Param('projectId', new ParseUUIDPipe()) id: string) { return this.service.exportProject(req.authUser, id); }
  @Post('projects/:projectId/deletion-requests') @HttpCode(202)
  deletion(@Req() req: AuthenticatedRequest, @Param('projectId', new ParseUUIDPipe()) id: string, @Body() body: DeleteProjectDto) { return this.service.requestDeletion(req.authUser, id, body.confirmed); }
  @Get('deletion-requests/:requestId')
  deletionStatus(@Req() req: AuthenticatedRequest, @Param('requestId', new ParseUUIDPipe()) id: string) { return this.service.deletionStatus(req.authUser, id); }
}
