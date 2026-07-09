import { Module } from '@nestjs/common';
import { CodigosOrigemController } from './codigos-origem.controller';
import { CodigosOrigemService } from './codigos-origem.service';

@Module({
  controllers: [CodigosOrigemController],
  providers: [CodigosOrigemService],
})
export class CodigosOrigemModule {}
