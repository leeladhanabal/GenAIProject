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
import { CreateProjectDto } from './dto/create-project.dto';
import { RegisterTargetDto } from './dto/register-target.dto';
import { ProjectsService } from './projects.service';

@Controller('projects')
@UseGuards(GoogleIdTokenGuard)
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  createProject(
    @Req() request: AuthenticatedRequest,
    @Body() input: CreateProjectDto,
  ) {
    return this.projectsService.createProject(request.authUser, input);
  }

  @Get()
  listProjects(@Req() request: AuthenticatedRequest) {
    return this.projectsService.listProjects(request.authUser);
  }

  @Post(':projectId/targets')
  registerTarget(
    @Req() request: AuthenticatedRequest,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
    @Body() input: RegisterTargetDto,
  ) {
    return this.projectsService.registerTarget(
      request.authUser,
      projectId,
      input,
    );
  }

  @Get(':projectId/targets')
  listTargets(
    @Req() request: AuthenticatedRequest,
    @Param('projectId', new ParseUUIDPipe()) projectId: string,
  ) {
    return this.projectsService.listTargets(request.authUser, projectId);
  }
}
