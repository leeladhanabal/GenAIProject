import {
  Controller,
  Get,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Controller('health')
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  getHealth(): { status: 'ok'; service: string; timestamp: string } {
    return {
      status: 'ok',
      service: 'ai-performance-agent-api',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async getReadiness(): Promise<{
    status: 'ok';
    service: string;
    dependencies: { database: 'ok' };
    timestamp: string;
  }> {
    try {
      await this.database.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({
        code: 'database_unavailable',
        message: 'Database is unavailable',
      });
    }

    return {
      status: 'ok',
      service: 'ai-performance-agent-api',
      dependencies: { database: 'ok' },
      timestamp: new Date().toISOString(),
    };
  }
}
