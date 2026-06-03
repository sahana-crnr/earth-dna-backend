// Root controller. Handles the base GET "/" route — used as a health/hello check.
import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getStarted(): string {
    return this.appService.getStarted();
  }
}
