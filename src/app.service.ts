// Root service. Provides the business logic for the base AppController.
import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getStarted(): string {
    return 'Welcome to the Earth DNA API!';
  }
}
