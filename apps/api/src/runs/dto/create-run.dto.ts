import { Type } from 'class-transformer';
import { Equals, IsBoolean, IsDefined, IsInt, IsUUID, Min, ValidateNested } from 'class-validator';

export class RunWorkloadDto {
  @IsInt()
  @Min(1)
  virtualUsers!: number;

  @IsInt()
  @Min(1)
  durationSeconds!: number;
}

export class CreateRunDto {
  @IsUUID()
  targetId!: string;

  @IsInt()
  @Min(1)
  planVersion!: number;

  @IsDefined()
  @ValidateNested()
  @Type(() => RunWorkloadDto)
  workload!: RunWorkloadDto;

  @IsBoolean()
  @Equals(true)
  authorizationConfirmed!: boolean;

  @IsBoolean()
  @Equals(true)
  approved!: boolean;
}
