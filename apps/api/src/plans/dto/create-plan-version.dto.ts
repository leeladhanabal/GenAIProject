import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreatePlanVersionDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  requirementsText!: string;

  @IsOptional()
  @IsObject()
  specification?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  script?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
