import { Injectable, Inject } from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';

@Injectable()
export class LojasService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
  ) {}
  // TODO: implementar métodos
}
