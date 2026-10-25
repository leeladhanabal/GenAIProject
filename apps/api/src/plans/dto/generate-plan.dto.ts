import { Equals, IsBoolean, IsInt, IsObject, IsString, IsUUID, Matches, Min } from 'class-validator';

export class GeneratePlanDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsUUID()
  targetId!: string;

  @IsObject()
  workload!: Record<string, unknown>;
}

export class ReviewScriptDto {
  @IsBoolean()
  @Equals(true)
  reviewed!: boolean;

  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  sha256!: string;
}
